#!/usr/bin/env node
// Release automation for the version-line flow described in RELEASING.md.
// Zero dependencies, Node 18+. Repositories run it through the kit's reusable workflows (pinned at @v1).
//
//   rc           tag vX.Y.Z-rc on a push to release/vX.Y (vX.Y.Z-hf-rc on hotfix/vX.Y), plus a
//                prerelease; skips a commit that already has a final or an older line's rc (a cut: no
//                new code); every new candidate takes the next patch of X.Y, release and hotfix alike
//                (v0.2.0-rc, v0.2.1-rc, …, then v0.2.2-hf-rc after v0.2.1); rc and final re-runs on an
//                already-tagged commit create the GitHub release if it is missing
//   sync        open "chore(sync): merge A into B" into the next open release line
//   final        tag the line's last rc as final, its name without -rc (v0.2.1-rc → v0.2.1,
//                v0.2.3-hf-rc → v0.2.3-hf), on the merge of a version line into the default branch,
//                plus a release marked latest; refuses when prod does not run that rc
//                (if DEPLOY_PROD_APPS is set); then opens "chore(sync): merge <default> into <release>"
//                if the next open release lacks the default branch, comments on the PRs still open
//                from the shipped line, and deletes its branch
//   cut-release  create the next release/vX.Y from the newest open release (or the default branch);
//                refuses while that release's head has no rc yet
//   cut-hotfix   create hotfix/vX.Y from the final tag in prod (vX.Y.Z or vX.Y.Z-hf)
//   conventions  check a PR's branch name, title and target (used by the PR checks workflow)
//   cleanup      delete a feature/fix branch once its PR is merged into a version line
//                (version lines and the default branch are never deleted here)
//   deploy-check gate a deploy: any release tag for test stages; --prod only for the last rc of an
//                open line that contains the default branch, or a final (vX.Y.Z, vX.Y.Z-hf) whose code
//                equals its rc (rollback)
//   deploy       deploy a release tag to the test or prod apps on Cubeship (passes deploy-check first),
//                then fail unless each app's container comes up and stays up (see waitForHealthy)
//   status       print the release state of the repo (read-only)
//   report       after an automatic job (rc, deploy-test, final, cleanup): on a failure open the issue
//                "Release automation failing: <job> on <line>" (label release-kit) or comment on it
//                if it is already open; on a success comment "Fixed by <run>" and close it
//
// On any failure the error is also written, on one line, as the step output `error` (GITHUB_OUTPUT),
// for the report job.
//
// Flags: --dry-run (print, change nothing), --no-fetch, --branch, --sha, --head, --version,
//        --title, --base, --prod, --stage, --apps, --job, --line, --result, --run-url, --error. Env: DEFAULT_BRANCH, GITHUB_REPOSITORY,
//        GH_TOKEN/GITHUB_TOKEN, TICKET_PATTERN, PR_TITLE, HEAD_REF, BASE_REF, HEAD_SHA,
//        CUBESHIP_URL, CUBESHIP_TOKEN, DEPLOY_TEST_APPS, DEPLOY_PROD_APPS,
//        RELEASE_HEALTH_STABLE_S, RELEASE_HEALTH_WAIT_S, GITHUB_REF_TYPE + GITHUB_REF_NAME (a
//        deploy with no tag takes the tag or the line the run starts from).

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'chore', 'refactor', 'perf', 'docs', 'test', 'ci', 'build', 'revert'];
const LINE_RE = /^(release|hotfix)\/v(\d+)\.(\d+)$/;
// Release tags: vX.Y.Z-rc (a release line's candidate) and vX.Y.Z (its final); vX.Y.Z-hf-rc (a
// hotfix line's candidate) and vX.Y.Z-hf (its final). Read but never written: the legacy candidate
// vX.Y.Z-rc.N and hotfix tags from before -hf (plain vX.Y.Z-rc / vX.Y.Z). Anything else (a manual
// v1.0) is not a release tag and is ignored.
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-hf)?(-rc(?:\.(\d+))?)?$/;
const BOT_NAME = 'github-actions[bot]';
const BOOLEAN_FLAGS = new Set(['dry-run', 'no-fetch', 'prod']);

class Failure extends Error {}
const fail = (msg) => { throw new Failure(msg); };
const inActions = process.env.GITHUB_ACTIONS === 'true';

// ---------- args ----------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) opts[key] = inline;
    else if (BOOLEAN_FLAGS.has(key)) opts[key] = true;
    else if (i + 1 < argv.length) opts[key] = argv[++i];
    else opts[key] = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._.shift();
const dryRun = Boolean(opts['dry-run']);

// ---------- output ----------

const log = (msg = '') => console.log(msg);
const act = (msg) => log(dryRun ? `[dry-run] would ${msg}` : `→ ${msg}`);
const warn = (msg) => log(inActions ? `::warning::${msg}` : `warning: ${msg}`);
function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}
// The job summary of a change: what was done, or under --dry-run what would have been.
const outcome = (done, would) => summary(dryRun ? `**Dry run, nothing changed.** Would ${would}` : done);
// A step output for later jobs (`steps.<id>.outputs.<key>`).
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// ---------- git ----------

// A failing git command reads as git's own message, not a Node stack.
function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new Failure(`git ${args.join(' ')} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}
function gitOk(...args) {
  try { git(...args); return true; } catch { return false; }
}
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const remoteRef = (branch) => `refs/remotes/origin/${branch}`;
const branchExists = (branch) => gitOk('rev-parse', '--verify', '--quiet', remoteRef(branch));
const commitOf = (ref) => git('rev-parse', `${ref}^{commit}`);
const treeOf = (ref) => git('rev-parse', `${ref}^{tree}`);
const isAncestor = (a, b) => gitOk('merge-base', '--is-ancestor', a, b);
// Asks the remote itself, so it holds in shallow checkouts that never fetched that branch.
const remoteHasBranch = (branch) => git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`) !== '';

let defaultBranchCache;
function defaultBranch() {
  if (defaultBranchCache) return defaultBranchCache;
  let found = process.env.DEFAULT_BRANCH;
  if (!found) {
    try { found = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, ''); } catch {}
  }
  if (!found) {
    try {
      const m = git('ls-remote', '--symref', 'origin', 'HEAD').match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
      if (m) found = m[1];
    } catch {}
  }
  if (!found) {
    const candidates = ['main', 'master'].filter(branchExists);
    if (candidates.length === 1) found = candidates[0];
    else fail('cannot detect the default branch; set DEFAULT_BRANCH');
  }
  return (defaultBranchCache = found);
}

// ---------- versions ----------

function parseTag(name) {
  const m = TAG_RE.exec(name);
  if (!m) return null;
  // hf: a hotfix tag (-hf). rc: null for a final, 0 for vX.Y.Z[-hf]-rc, N for the legacy vX.Y.Z-rc.N.
  return {
    name, major: +m[1], minor: +m[2], patch: +m[3], hf: m[4] !== undefined,
    rc: m[5] === undefined ? null : +(m[6] ?? 0),
  };
}
function parseLine(name) {
  const m = LINE_RE.exec(name ?? '');
  return m ? { name, kind: m[1], major: +m[2], minor: +m[3] } : null;
}
// By X.Y.Z; in the same patch the rc comes before the final. The kit orders tags itself (for
// SemVer, -hf would be a pre-release that sorts before vX.Y.Z).
function cmpTag(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
    || (a.rc ?? Number.MAX_SAFE_INTEGER) - (b.rc ?? Number.MAX_SAFE_INTEGER);
}
const cmpLine = (a, b) => a.major - b.major || a.minor - b.minor;
// The candidate a line creates: vX.Y.Z-rc on release/vX.Y, vX.Y.Z-hf-rc on hotfix/vX.Y.
const rcName = (line, patch) => `v${line.major}.${line.minor}.${patch}${line.kind === 'hotfix' ? '-hf' : ''}-rc`;
// A final is named after the rc it ships: v0.2.2-rc → v0.2.2, v1.29.9-hf-rc → v1.29.9-hf, the
// legacy v0.3.0-rc.1 → v0.3.0 (and a hotfix rc from before -hf, v0.6.3-rc → v0.6.3).
const finalName = (rc) => rc.name.replace(/-rc(?:\.\d+)?$/, '');

let stateCache;
function state() {
  if (stateCache) return stateCache;
  // --force: a tag checkout can leave a local copy of a tag that differs from the remote's (a
  // lightweight one where the remote has an annotated tag), and a plain fetch refuses to replace
  // it. The remote is the truth: only the automation creates tags.
  if (!opts['no-fetch']) git('fetch', 'origin', '--tags', '--prune', '--force');
  const tags = lines(git('tag', '--list', 'v*')).map(parseTag).filter(Boolean).sort(cmpTag);
  const branches = lines(git('for-each-ref', '--format=%(refname:strip=3)',
    'refs/remotes/origin/release', 'refs/remotes/origin/hotfix')).map(parseLine).filter(Boolean).sort(cmpLine);
  return (stateCache = { tags, branches });
}

// Finals are vX.Y.Z and vX.Y.Z-hf alike (rc === null): both are what prod runs.
const finalsOf = (major, minor) => state().tags.filter((t) => t.rc === null && t.major === major && t.minor === minor);
// The rc a final shipped: the last one with its X.Y.Z and its -hf (v1.29.9-hf ← v1.29.9-hf-rc).
const rcOf = (final) => state().tags.filter((t) => t.rc !== null && t.major === final.major
  && t.minor === final.minor && t.patch === final.patch && t.hf === final.hf).at(-1);
const finals = () => state().tags.filter((t) => t.rc === null);
const openReleases = () => state().branches.filter((b) => b.kind === 'release' && finalsOf(b.major, b.minor).length === 0);

// Candidates of an X.Y line since its last final: the current release or hotfix in progress.
function pendingRcs(major, minor) {
  const shipped = finalsOf(major, minor).at(-1);
  return state().tags.filter((t) => t.rc !== null && t.major === major && t.minor === minor
    && (!shipped || t.patch > shipped.patch));
}

// Each candidate takes a new patch: after the line's last rc, else after its last final, else 0.
function nextPatch(major, minor) {
  const last = pendingRcs(major, minor).at(-1) ?? finalsOf(major, minor).at(-1);
  return last ? last.patch + 1 : 0;
}

// Refuses version lines that cannot take changes.
function checkLine(branch) {
  const line = parseLine(branch);
  if (!line) fail(`"${branch}" is not a version line (release/vX.Y or hotfix/vX.Y)`);
  const shipped = finalsOf(line.major, line.minor);
  if (line.kind === 'release' && shipped.length) {
    fail(`${branch} already shipped as ${shipped[0].name}; fixes for prod go through cut-hotfix`);
  }
  if (line.kind === 'hotfix' && !shipped.length) {
    fail(`${branch} has nothing in prod to fix: no final v${line.major}.${line.minor}.* tag`);
  }
  return line;
}

// The branch of a tag's X.Y line: the hotfix once X.Y shipped, else the release.
function lineOf(tag) {
  const same = state().branches.filter((b) => b.major === tag.major && b.minor === tag.minor);
  const kind = finalsOf(tag.major, tag.minor).length ? 'hotfix' : 'release';
  return (same.find((b) => b.kind === kind) ?? same[0])?.name ?? `the v${tag.major}.${tag.minor} line`;
}

// Highest final tag contained in the default branch: what is in prod.
function prodTag() {
  const head = remoteRef(defaultBranch());
  return finals().filter((t) => isAncestor(t.name, head)).at(-1) ?? null;
}

// ---------- GitHub API ----------

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const m = git('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    if (m) return m[1];
  } catch {}
  return null;
}
const token = () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// missingOk: a 404 answers null instead of failing (looking something up).
async function api(method, path, body, { missingOk = false } = {}) {
  const slug = repoSlug();
  if (!slug) fail('cannot tell the GitHub repository; set GITHUB_REPOSITORY=owner/name');
  if (!token()) fail('GitHub API needs GH_TOKEN or GITHUB_TOKEN');
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  let res;
  try {
    res = await fetch(`${base}/repos/${slug}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token()}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) { // GitHub unreachable: a message, not a Node stack
    fail(`GitHub API ${method} ${path}: ${err.cause?.code || err.cause?.message || err.message}`);
  }
  const text = await res.text();
  if (missingOk && res.status === 404) return null;
  if (!res.ok) fail(`GitHub API ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- actions (each respects --dry-run) ----------

function createTag(name, sha, message) {
  act(`create tag ${name} on ${sha.slice(0, 12)}`);
  if (dryRun) return;
  git('tag', '--annotate', name, sha, '--message', message);
  git('push', 'origin', `refs/tags/${name}`);
}

function createBranch(name, sha) {
  act(`create branch ${name} at ${sha.slice(0, 12)}`);
  if (dryRun) return;
  git('push', 'origin', `${sha}:refs/heads/${name}`);
}

// A shipped line takes no more rcs and hotfixes branch from the final tag, so its branch goes.
// Never fatal: the final tag is already out, and a leftover branch only needs a manual delete.
function deleteBranch(name) {
  if (!remoteHasBranch(name)) return;
  act(`delete branch ${name}`);
  if (dryRun) return;
  try { git('push', 'origin', '--delete', name); } catch (err) {
    warn(`could not delete ${name} (${err.message}); delete it by hand`);
  }
}

async function createRelease(tag, sha, previous, prerelease) {
  act(`create GitHub ${prerelease ? 'prerelease' : 'release'} ${tag}`
    + `${previous ? ` with notes since ${previous}` : ''}`);
  if (dryRun) return;
  const notes = await api('POST', '/releases/generate-notes', {
    tag_name: tag, target_commitish: sha, ...(previous ? { previous_tag_name: previous } : {}),
  });
  await api('POST', '/releases', {
    tag_name: tag, name: tag, body: notes.body, prerelease, make_latest: prerelease ? 'false' : 'true',
  });
}

// The GitHub release of a tag that is already out. A run that pushed the tag and then failed to
// create the release (a GitHub error) leaves it missing, and its re-run only lands on "already";
// so the re-run creates it. Unlike the steps after a ship, an API error here fails the job: a
// missing release must show.
async function ensureRelease(tag, sha, previous, prerelease) {
  if (dryRun && !token()) { log(`  (no GitHub token: skipping the check for the ${tag} release)`); return; }
  if (await api('GET', `/releases/tags/${encodeURIComponent(tag)}`, undefined, { missingOk: true })) {
    log(`✓ release ${tag} already exists`);
    return;
  }
  await createRelease(tag, sha, previous, prerelease);
}

// The sync PR's number (the open one, or the one it opens); null under --dry-run.
async function openSyncPr(source, target) {
  const title = `chore(sync): merge ${source} into ${target}`;
  const owner = (repoSlug() ?? '').split('/')[0];
  if (token() && owner) {
    const open = await api('GET', `/pulls?state=open&head=${owner}:${encodeURIComponent(source)}`
      + `&base=${encodeURIComponent(target)}`);
    if (open.length) { log(`✓ sync PR already open: #${open[0].number} ${title}`); return open[0].number; }
  } else if (dryRun) {
    log('  (no GitHub token: skipping the check for an already-open sync PR)');
  }
  act(`open PR "${title}"`);
  if (dryRun) return null;
  const pr = await api('POST', '/pulls', {
    title, head: source, base: target,
    body: [
      `Automatic sync: brings the changes of \`${source}\` into \`${target}\`.`,
      '',
      '- Merge with a **merge commit** (never squash or rebase).',
      `- On conflicts, resolve on a branch cut from \`${target}\` and PR it into \`${target}\`; never edit \`${source}\`.`,
    ].join('\n'),
  });
  log(`✓ opened #${pr.number}`);
  return pr.number;
}

// Comments on each open PR whose head is `head` (GitHub closes them once that branch is deleted).
async function commentOnOpenPrs(head, body) {
  const owner = (repoSlug() ?? '').split('/')[0];
  if (dryRun && !(token() && owner)) {
    log(`  (no GitHub token: skipping the check for open PRs from ${head})`);
    act(`comment on open PRs from ${head}: "${body}"`);
    return;
  }
  if (!owner) fail('cannot tell the GitHub repository; set GITHUB_REPOSITORY=owner/name');
  const open = await api('GET', `/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`);
  if (!open.length) { log(`✓ no open PRs from ${head}`); return; }
  act(`comment on open PRs from ${head}: "${body}"`);
  if (dryRun) { log(`  (open: ${open.map((p) => `#${p.number}`).join(', ')})`); return; }
  for (const pr of open) {
    await api('POST', `/issues/${pr.number}/comments`, { body });
    log(`✓ commented on #${pr.number}`);
  }
}

// After a line ships, before its branch goes: the next open release must get the default branch
// (now holding the shipped line), and the PRs still open from the shipped branch, which GitHub
// closes with it, say where their changes went. The final tag is already out, so a GitHub error
// here is a warning, never a failure.
async function afterShip(head, tag, sha) {
  const def = defaultBranch();
  // The state was read before the tag, so `head` may still look open.
  const next = openReleases().find((r) => r.name !== head);
  let pr = null; // null under --dry-run, where the PR only would be opened
  let synced = true;
  let refused = false;
  if (next && !isAncestor(sha, remoteRef(next.name))) {
    synced = false;
    try { pr = await openSyncPr(def, next.name); } catch (err) {
      refused = true;
      warn(`could not open the sync PR from ${def} into ${next.name} (${err.cause?.code || err.message}); open it by hand`);
    }
  }
  // The comment stays on the closed PRs, so it never points at a sync PR that does not exist.
  const where = !next ? `its changes are in ${def}.`
    : synced ? `its changes are already in ${next.name}.`
      : refused ? `its changes are in ${def} but no sync PR into ${next.name} could be opened: `
        + `open one (merge ${def} into ${next.name}).`
        : `its changes reach ${next.name} through ${pr ? `#${pr}` : 'the sync PR'}.`;
  try { await commentOnOpenPrs(head, `Closed because ${head} shipped as ${tag}; ${where}`); } catch (err) {
    warn(`could not comment on the open PRs from ${head} (${err.cause?.code || err.message})`);
  }
  deleteBranch(head);
}

// ---------- Cubeship (deploys) ----------

// Apps that build from Git, whose `ref` can point at a tag.
const BUILDING_SOURCES = new Set(['dockerfile', 'railpack']);
const DEPLOY_WAIT_MS = 45 * 60 * 1000;

function stageApps(stage) {
  const raw = opts.apps ?? process.env[stage === 'prod' ? 'DEPLOY_PROD_APPS' : 'DEPLOY_TEST_APPS'] ?? '';
  return raw.split(/[\s,]+/).filter(Boolean);
}
const hasCubeship = () => Boolean(process.env.CUBESHIP_URL && process.env.CUBESHIP_TOKEN);

async function cubeship(method, path, body) {
  const base = (process.env.CUBESHIP_URL || '').replace(/\/+$/, '');
  if (!base) fail('set CUBESHIP_URL to the Cubeship API, e.g. https://cubeship.example.com/api');
  if (!process.env.CUBESHIP_TOKEN) fail('set the CUBESHIP_TOKEN secret (a Cubeship API key)');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${process.env.CUBESHIP_TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) fail(`Cubeship ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function appPath(ref) {
  const parts = ref.split('/');
  if (parts.length !== 3 || parts.some((p) => !p)) fail(`"${ref}" must be project/environment/app`);
  return `/apps/${parts.map(encodeURIComponent).join('/')}`;
}

async function getBuildingApp(ref) {
  const app = await cubeship('GET', appPath(ref));
  if (!BUILDING_SOURCES.has(app.source)) {
    fail(`${ref} uses source "${app.source}"; deploys by tag need an app that builds from Git (dockerfile or railpack)`);
  }
  return app;
}

// The API answers a bare array, newest first; `{ items }` is accepted too (the MCP tools' shape).
async function lastDeployment(ref) {
  const res = await cubeship('GET', `${appPath(ref)}/deployments`);
  const list = Array.isArray(res) ? res : (res?.items ?? []);
  return list[0] ?? null;
}

// True when the app is set to `tag` and its latest deploy built that commit successfully.
async function runs(ref, app, tag) {
  if (app.ref !== tag) return false;
  const last = await lastDeployment(ref);
  return Boolean(last && last.status === 'succeeded' && last.git_sha === commitOf(tag));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEPLOY_POLL_MS = Number(process.env.RELEASE_DEPLOY_POLL_MS) || 10_000;
const MAX_POLL_ERRORS = 6;

// Short polls, not `?wait=true`: a build outlives the few minutes a proxy keeps a request open,
// and a dropped poll is retried instead of failing a deploy that is still running.
async function waitForDeploy(ref, id) {
  const started = Date.now();
  let errors = 0;
  for (;;) {
    let d;
    try {
      d = await cubeship('GET', `${appPath(ref)}/deployments/${id}`);
      errors = 0;
    } catch (err) {
      if (err instanceof Failure || ++errors > MAX_POLL_ERRORS) throw err;
      warn(`could not read deploy #${id} of ${ref} (${err.cause?.code || err.message}); retrying`);
    }
    if (d?.status === 'succeeded' || d?.status === 'skipped') return d;
    if (d && (d.status === 'failed' || d.cancelled)) fail(`deploy #${id} of ${ref} failed: ${d.error || d.status}`);
    if (Date.now() - started > DEPLOY_WAIT_MS) fail(`deploy #${id} of ${ref} still ${d?.status ?? 'unknown'} after 45 min`);
    await sleep(DEPLOY_POLL_MS);
  }
}

// Seconds from the environment; unset or empty (an unset GitHub variable) means the default.
function envSeconds(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(`${name} must be a number of seconds, got "${raw}"`);
  return n;
}
const HEALTH_POLL_MS = Number(process.env.RELEASE_HEALTH_POLL_MS) || 5_000;

// Cubeship calls a deploy "succeeded" once it has started the new container, and the app's
// `replicas` keep saying `running` while that container crashloops (a missing env var, a failed
// migration). The live view is /instance/containers: one entry per running container, named by
// app reference, with its `started_at`, refreshed every ~30 s. A crashloop shows there as a
// `started_at` that keeps changing, or as no entry at all. So after each deploy: wait up to
// RELEASE_HEALTH_WAIT_S (default 300) for a snapshot whose containers for this app all started
// after the deploy began, then require a snapshot RELEASE_HEALTH_STABLE_S (default 60) later to
// show the same containers, none restarted. RELEASE_HEALTH_STABLE_S=0 turns the check off.
async function waitForHealthy(ref, deploy) {
  const stableS = envSeconds('RELEASE_HEALTH_STABLE_S', 60);
  if (stableS === 0) { log(`  (RELEASE_HEALTH_STABLE_S=0: not checking that ${ref} stays up)`); return; }
  const waitS = envSeconds('RELEASE_HEALTH_WAIT_S', 300);
  // A skipped deploy started no container, so whatever runs must just stay up.
  const since = deploy.status === 'skipped' ? 0 : Date.parse(deploy.created_at ?? '');
  if (!Number.isFinite(since)) fail(`${ref}: deploy #${deploy.id} has no created_at; cannot tell its containers from older ones`);
  const started = Date.now();
  let first = null; // the first snapshot that shows this deploy's containers: { at, starts }
  let errors = 0;
  for (;;) {
    let list = null;
    try {
      list = await cubeship('GET', '/instance/containers');
      errors = 0;
    } catch (err) {
      if (err instanceof Failure && /: 40[134] /.test(err.message)) {
        fail(`${ref}: cannot read Cubeship's live containers to check that the deploy stays up (${err.message}). `
          + 'Give the CUBESHIP_TOKEN key view on servers (the Deploy role has it), or set RELEASE_HEALTH_STABLE_S=0 to skip the check.');
      }
      if (err instanceof Failure || ++errors > MAX_POLL_ERRORS) throw err;
      warn(`could not read Cubeship's live containers (${err.cause?.code || err.message}); retrying`);
    }
    const items = Array.isArray(list) ? list : (list?.items ?? []);
    if (items.length) {
      const at = Date.parse(items[0].at ?? '') || Date.now();
      const starts = items.filter((c) => c.kind === 'app' && c.name === ref).map((c) => c.started_at).sort();
      const fresh = starts.length > 0 && starts.every((t) => Date.parse(t) >= since);
      if (!first) {
        if (fresh) first = { at, starts: starts.join(', ') };
      } else if (starts.join(', ') !== first.starts) {
        fail(`${ref}: deploy #${deploy.id} is not staying up: its container started at ${first.starts}, then `
          + (starts.length ? `started again at ${starts.join(', ')}` : 'stopped')
          + '. Cubeship still calls the deploy "succeeded". Read its logs in Cubeship, or roll back by deploying the previous tag.');
      } else if (at - first.at >= stableS * 1000) {
        return;
      }
    }
    if (!first && Date.now() - started > waitS * 1000) {
      fail(`${ref}: deploy #${deploy.id} did not come up in ${waitS}s (no container of it running). `
        + 'Cubeship may still call the deploy "succeeded". Read its logs in Cubeship, or roll back by deploying the previous tag.');
    }
    await sleep(HEALTH_POLL_MS);
  }
}

// Points each app at the tag and deploys it, in the listed order (e.g. api before web), and stops
// at the first app whose container does not stay up, so a broken api never gets a web in front.
async function deployTag(tag, apps) {
  for (const ref of apps) {
    if (dryRun && !hasCubeship()) { act(`set ${ref} to ${tag} and deploy it`); continue; }
    const app = await getBuildingApp(ref);
    if (await runs(ref, app, tag)) {
      // A re-run of a failed job lands here too: "succeeded" in Cubeship says nothing about now.
      if (!dryRun) await waitForHealthy(ref, await lastDeployment(ref));
      log(`✓ ${ref} already runs ${tag}`);
      continue;
    }
    // A re-run after a dropped wait: that deploy of this tag is still going, so wait for it.
    const last = app.ref === tag ? await lastDeployment(ref) : null;
    if (!dryRun && last?.status === 'pending' && last.git_sha === commitOf(tag)) {
      log(`${ref} is already deploying ${tag} (deploy #${last.id}); waiting for it`);
      const done = await waitForDeploy(ref, last.id);
      await waitForHealthy(ref, done);
      log(`✓ ${ref} runs ${tag} (deploy #${done.id})`);
      continue;
    }
    act(`set ${ref} to ${tag} (was ${app.ref}) and deploy it`);
    if (dryRun) continue;
    // The source and its settings travel together, so the source, repo and recipe go with the ref.
    await cubeship('PATCH', appPath(ref), {
      source: app.source, repo: app.repo, ref: tag, ...(app.dockerfile ? { dockerfile: app.dockerfile } : {}),
    });
    const started = await cubeship('POST', `${appPath(ref)}/deploy`, {});
    const done = await waitForDeploy(ref, started.id);
    log(`  ${ref}: deploy #${done.id} built and started; checking that it stays up`);
    await waitForHealthy(ref, done);
    log(`✓ ${ref} runs ${tag} (deploy #${done.id}, ${Math.round((done.duration_ms ?? 0) / 1000)}s)`);
  }
}

// ---------- commands ----------

const currentBranch = () => opts.branch || process.env.GITHUB_REF_NAME || git('branch', '--show-current');
const shaOf = (branch) => opts.sha || process.env.GITHUB_SHA || commitOf(branchExists(branch) ? remoteRef(branch) : branch);

// Release tags (final or rc, any line) on a commit.
const releaseTagsOn = (sha) => state().tags.filter((t) => commitOf(t.name) === sha);
// Tags on a commit that mean "no new code" for `line`: a final, or an rc of an older line (what a
// cut starts from). A newer line's rc does not: cut from this line's head, it may tag that commit
// before this line's own rc job runs.
const blockingTagsOn = (sha, line) => releaseTagsOn(sha).filter((t) => t.rc === null || cmpLine(t, line) < 0);

// Step output `tag`: this line's rc on the pushed commit, empty when there is none, so the
// test-stage deploy runs only for a commit that is (or already was) this line's candidate.
async function cmdRc() {
  const branch = currentBranch();
  const line = checkLine(branch);
  const sha = shaOf(branch);
  const rcs = pendingRcs(line.major, line.minor);
  const already = rcs.find((r) => commitOf(r.name) === sha);
  if (already) {
    log(`✓ ${sha.slice(0, 12)} is already ${already.name}; nothing to do`);
    // A re-run of a job that tagged and then failed: notes since the rc before it, as the first run.
    const before = rcs[rcs.indexOf(already) - 1]?.name
      ?? finals().filter((f) => cmpTag(f, already) < 0).at(-1)?.name;
    await ensureRelease(already.name, sha, before, true);
    output('tag', already.name);
    return;
  }
  // A commit that already carries a release tag has no new code: a cut (release from an open
  // release, hotfix from the final in prod) pushes such a commit, and it must not become an rc.
  const tagged = blockingTagsOn(sha, line).map((t) => t.name);
  if (tagged.length) {
    log(`✓ ${sha.slice(0, 12)} is already ${tagged.join(', ')}: no new code on ${branch}, no rc; `
      + 'the first change merged into it takes one');
    summary(`No rc for \`${branch}\`: ${sha.slice(0, 12)} is already ${tagged.map((t) => `**${t}**`).join(', ')} (no new code)`);
    output('tag', '');
    return;
  }
  const last = rcs.at(-1);
  const tag = rcName(line, nextPatch(line.major, line.minor));
  const previous = last?.name ?? finals().filter((f) => cmpTag(f, parseTag(tag)) < 0).at(-1)?.name;
  log(`${branch} → ${tag} (${last ? `last rc ${last.name}` : 'first rc'})`);
  createTag(tag, sha, `Release candidate ${tag} from ${branch}`);
  await createRelease(tag, sha, previous, true);
  output('tag', dryRun ? '' : tag);
  outcome(`Release candidate **${tag}** from \`${branch}\` (${sha.slice(0, 12)})`,
    `tag **${tag}** on \`${branch}\` (${sha.slice(0, 12)})`);
}

async function cmdSync() {
  const branch = currentBranch();
  const line = parseLine(branch);
  if (!line) fail(`"${branch}" is not a version line (release/vX.Y or hotfix/vX.Y)`);
  const sha = shaOf(branch);
  // One hop only: merging the sync PR pushes to the target, whose own sync carries it further.
  const target = openReleases().find((r) => line.kind === 'hotfix' || cmpLine(r, line) > 0);
  if (!target) { log(`✓ no open release line after ${branch}; nothing to sync`); return; }
  const ahead = Number(git('rev-list', '--count', `${remoteRef(target.name)}..${sha}`));
  if (!ahead) { log(`✓ ${target.name} already has everything from ${branch}`); return; }
  log(`${branch} has ${ahead} commit(s) not in ${target.name}`);
  await openSyncPr(branch, target.name);
}

async function cmdFinal() {
  const head = opts.head || process.env.HEAD_REF;
  if (!head) fail('final needs --head <release/vX.Y|hotfix/vX.Y> (the merged PR branch)');
  const def = defaultBranch();
  const sha = opts.sha || process.env.MERGE_SHA || commitOf(remoteRef(def));
  if (!isAncestor(sha, remoteRef(def))) fail(`${sha.slice(0, 12)} is not on ${def}`);
  const line = parseLine(head);
  if (!line) fail(`"${head}" is not a version line (release/vX.Y or hotfix/vX.Y)`);
  const shipped = finalsOf(line.major, line.minor).at(-1);
  if (shipped && commitOf(shipped.name) === sha) {
    log(`✓ ${shipped.name} already on ${sha.slice(0, 12)}`);
    const before = finals().filter((f) => cmpTag(f, shipped) < 0).at(-1)?.name;
    await ensureRelease(shipped.name, sha, before, false);
    await afterShip(head, shipped.name, sha);
    return;
  }
  checkLine(head);
  const lastRc = pendingRcs(line.major, line.minor).at(-1);
  if (!lastRc) fail(`${head} has no rc since ${shipped?.name ?? 'it was cut'}: it was never tested as a release candidate; not tagging a final`);
  const tag = finalName(lastRc);
  if (gitOk('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`)) {
    fail(`${tag} already exists on another commit (${commitOf(tag).slice(0, 12)})`);
  }
  const prodApps = stageApps('prod');
  if (treeOf(lastRc.name) !== treeOf(sha)) {
    fail(`the code merged into ${def} differs from ${lastRc.name}; not tagging ${tag}. `
      + `Fix: merge ${def} into ${head} with a PR (new rc)`
      + `${prodApps.length ? ', deploy that rc to prod' : ''}, then PR ${head} into ${def} again.`);
  }
  if (prodApps.length) await checkProdRuns(lastRc.name, prodApps, tag);
  const previous = finals().filter((f) => cmpTag(f, parseTag(tag)) < 0).at(-1)?.name;
  log(`${head} merged into ${def} → ${tag} (same code as ${lastRc.name})`);
  createTag(tag, sha, `Release ${tag} (from ${head}, same code as ${lastRc.name})`);
  await createRelease(tag, sha, previous, false);
  await afterShip(head, tag, sha);
  outcome(`Shipped **${tag}** from \`${head}\` (same code as ${lastRc.name})`,
    `ship **${tag}** from \`${head}\` (same code as ${lastRc.name})`);
}

// The final only records what prod already runs: the line's last rc, deployed before the merge.
async function checkProdRuns(rc, apps, tag) {
  if (!hasCubeship()) {
    if (dryRun) { log(`  (no Cubeship credentials: skipping the check that prod runs ${rc})`); return; }
    fail(`DEPLOY_PROD_APPS is set but CUBESHIP_URL or CUBESHIP_TOKEN is missing; cannot check that prod runs ${rc}`);
  }
  const behind = [];
  for (const ref of apps) {
    const app = await getBuildingApp(ref);
    if (!(await runs(ref, app, rc))) behind.push(`${ref} (${app.ref})`);
  }
  if (behind.length) {
    fail(`prod does not run ${rc}: ${behind.join(', ')}; not tagging ${tag}. `
      + `Fix: Actions → Release → deploy, stage prod, tag ${rc}; then re-run this job.`);
  }
  log(`✓ prod runs ${rc}: ${apps.join(', ')}`);
}

async function cmdCutRelease() {
  const open = openReleases();
  const newest = open.at(-1);
  const shipped = finals().at(-1);
  let major, minor;
  if (opts.version) {
    const m = /^v?(\d+)\.(\d+)$/.exec(opts.version);
    if (!m) fail(`--version must be X.Y, got "${opts.version}"`);
    [major, minor] = [+m[1], +m[2]];
    for (const floor of [newest, shipped].filter(Boolean)) {
      if (cmpLine({ major, minor }, floor) <= 0) fail(`--version ${major}.${minor} must be newer than ${floor.name}`);
    }
  } else if (newest) {
    [major, minor] = [newest.major, newest.minor + 1];
  } else if (shipped) {
    [major, minor] = [shipped.major, shipped.minor + 1];
  } else {
    [major, minor] = [0, 1];
  }
  const branch = `release/v${major}.${minor}`;
  if (branchExists(branch)) fail(`${branch} already exists`);
  if (finalsOf(major, minor).length) fail(`v${major}.${minor} already shipped`);
  const from = newest ? newest.name : defaultBranch();
  // A cut at a head with no rc yet would race that head's own rc: the new line's rc job can tag the
  // commit first, and the older line then sees no new code and never gets its rc.
  if (newest) {
    const head = commitOf(remoteRef(newest.name));
    if (!releaseTagsOn(head).length) {
      fail(`${newest.name}'s head ${head.slice(0, 12)} has no rc yet (its Release run may still be running); `
        + 'wait for it, then cut again.');
    }
  }
  log(`open releases: ${open.map((r) => r.name).join(', ') || 'none'}; latest shipped: ${shipped?.name ?? 'none'}`);
  log(`${branch} branches from ${from}; its first rc will be ${rcName(parseLine(branch), 0)}`);
  createBranch(branch, commitOf(remoteRef(from)));
  outcome(`Cut **${branch}** from \`${from}\``, `cut **${branch}** from \`${from}\``);
}

async function cmdCutHotfix() {
  const prod = prodTag();
  if (!prod) fail(`no final vX.Y.Z tag on ${defaultBranch()}: nothing in prod to hotfix`);
  const branch = `hotfix/v${prod.major}.${prod.minor}`;
  const next = rcName(parseLine(branch), nextPatch(prod.major, prod.minor));
  log(`in prod: ${prod.name}; the hotfix's next rc will be ${next}`);
  if (branchExists(branch)) {
    const tip = remoteRef(branch);
    const shippedAlready = treeOf(tip) === treeOf(prod.name) || isAncestor(tip, remoteRef(defaultBranch()));
    log(`✓ ${branch} already exists (${shippedAlready ? 'same code as prod' : 'fix in progress'}); `
      + `open fix PRs into it`);
    return;
  }
  createBranch(branch, commitOf(prod.name));
  outcome(`Cut **${branch}** from \`${prod.name}\``, `cut **${branch}** from \`${prod.name}\``);
}

function cmdConventions() {
  const title = opts.title ?? process.env.PR_TITLE ?? '';
  const head = opts.head ?? process.env.HEAD_REF ?? '';
  const base = opts.base ?? process.env.BASE_REF ?? '';
  const def = defaultBranch();
  const ticket = process.env.TICKET_PATTERN || '[A-Z][A-Z0-9]+-\\d+';
  const types = TYPES.join('|');
  const errors = [];

  const headLine = parseLine(head);
  const githubRevert = /^revert-\d+-/.test(head) && /^Revert ".+"$/.test(title);
  if (headLine) {
    const baseLine = parseLine(base);
    if (base !== def && !baseLine) {
      errors.push(`${head} can only merge into ${def} or another version line, not "${base}"`);
    }
    // Changes flow forward only: an older line's fixes reach newer lines, never the reverse.
    if (baseLine && cmpLine(baseLine, headLine) <= 0) {
      errors.push(`${head} can merge only into ${def} or a newer line; ${base} is older.`);
    }
    if (!new RegExp(`^(${types})(\\([^)]+\\))?!?: \\S`).test(title)) {
      errors.push(`title "${title}" is not Conventional Commits, e.g. "chore(release): ship ${head}"`);
    }
    if (base === def) {
      const headSha = opts.sha || process.env.HEAD_SHA || commitOf(remoteRef(head));
      if (!isAncestor(remoteRef(def), headSha)) {
        errors.push(`${head} is behind ${def}: merge ${def} into ${head} first, so ${def} ships exactly a tested rc`);
      }
    }
  } else if (head === def && parseLine(base)) {
    // A sync PR that brings what shipped (the default branch) into an open line.
    if (!new RegExp(`^(${types})(\\([^)]+\\))?!?: \\S`).test(title)) {
      errors.push(`title "${title}" is not Conventional Commits, e.g. "chore(sync): merge ${def} into ${base}"`);
    }
  } else {
    if (base === def) errors.push(`only release/vX.Y or hotfix/vX.Y can merge into ${def}; target a release line`);
    if (!githubRevert) {
      const branchM = new RegExp(`^(${types})/(${ticket})-[a-z0-9]+(-[a-z0-9]+)*$`).exec(head);
      if (!branchM) errors.push(`branch "${head}" must be <type>/<TICKET>-short-name, e.g. feat/ABC-12-login (types: ${types})`);
      const titleM = new RegExp(`^(${types})\\((${ticket})\\)!?: (.+)$`).exec(title);
      if (!titleM) errors.push(`title "${title}" must be type(TICKET): summary, e.g. feat(ABC-12): add login`);
      else if (/^[A-Z]/.test(titleM[3])) errors.push(`summary "${titleM[3]}" must start lowercase (imperative)`);
      if (branchM && titleM && branchM[2] !== titleM[2]) {
        errors.push(`ticket in title (${titleM[2]}) differs from branch (${branchM[2]})`);
      }
    }
  }

  log(`PR ${head} → ${base} (default branch: ${def}): "${title}"`);
  if (errors.length) {
    errors.forEach((e) => log(inActions ? `::error::${e}` : `✗ ${e}`));
    summary(`### Conventions failed\n${errors.map((e) => `- ${e}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    log('✓ conventions ok');
  }
}

// Test stages take any release tag. Prod takes the last rc of an open line (release day: what was
// tested goes to prod, then the merge tags it final), or a final whose code equals its rc (rollback).
function checkDeploy(name, prod) {
  const tag = parseTag(name);
  if (!tag) fail(`"${name}" is not a release tag (vX.Y.Z, vX.Y.Z-rc, vX.Y.Z-hf or vX.Y.Z-hf-rc); branches and other refs never deploy`);
  if (!gitOk('rev-parse', '--verify', '--quiet', `refs/tags/${name}`)) fail(`tag ${name} does not exist`);
  if (!prod) { log(`✓ ${name} can go to a test stage`); return tag; }
  if (tag.rc !== null) {
    const last = pendingRcs(tag.major, tag.minor).at(-1);
    if (last?.name !== name) {
      fail(`${name} is not the last rc of an open v${tag.major}.${tag.minor} line`
        + `${last ? ` (that is ${last.name})` : ''}; prod takes only the line's last rc or a final`);
    }
    // The default branch is what prod runs (e.g. a hotfix shipped meanwhile); an rc without it
    // would take that away from prod. Once the line itself merged into the default branch (release
    // day, prod deployed after the merge), that merge commit is not in the rc but its code is the
    // rc's code, so nothing is lost.
    const def = defaultBranch();
    if (!isAncestor(remoteRef(def), name) && treeOf(remoteRef(def)) !== treeOf(name)) {
      fail(`${name} lacks what ${def} has (${def} at ${commitOf(remoteRef(def)).slice(0, 12)}, `
        + `prod ${prodTag()?.name ?? 'nothing'}): prod would lose it. `
        + `Merge the open sync PR (or ${def}) into ${lineOf(tag)}, then deploy the new rc.`);
    }
    log(`✓ ${name} can go to prod (last rc of v${tag.major}.${tag.minor}; the merge will tag it ${finalName(tag)})`);
    return tag;
  }
  // Rollback to a final (vX.Y.Z or vX.Y.Z-hf): only with the code of the rc it shipped.
  const lastRc = rcOf(tag);
  if (!lastRc) fail(`${name} has no ${name}-rc: its code was never tested as a release candidate`);
  if (treeOf(lastRc.name) !== treeOf(name)) fail(`${name} differs from its last rc ${lastRc.name}`);
  log(`✓ ${name} can go to prod (same code as ${lastRc.name})`);
  return tag;
}

// A feature/fix branch is done once squashed into a version line. Version lines stay (a sync PR
// has one as head) and only `final` deletes them, after their tag; the default branch always stays.
function cmdCleanup() {
  const head = opts.head ?? process.env.HEAD_REF ?? '';
  const base = opts.base ?? process.env.BASE_REF ?? '';
  if (!head) fail('cleanup needs --head <merged branch> and --base <its target>');
  if (!parseLine(base)) { log(`✓ ${base || '(no base)'} is not a version line; nothing to clean`); return; }
  if (parseLine(head) || head === defaultBranch()) { log(`✓ ${head} is a version line or the default branch; kept`); return; }
  if (!remoteHasBranch(head)) { log(`✓ ${head} is already gone`); return; }
  deleteBranch(head);
  outcome(`Deleted \`${head}\` (merged into \`${base}\`)`, `delete \`${head}\` (merged into \`${base}\`)`);
}

function cmdDeployCheck() {
  const name = opts._[0] || process.env.DEPLOY_TAG;
  if (!name) fail('deploy-check needs a tag: deploy-check vX.Y.Z[-hf][-rc] [--prod]');
  checkDeploy(name, Boolean(opts.prod));
}

// Lines that can still take a deploy: release/* not shipped yet and every hotfix/*, in line order.
const openLines = () => state().branches.filter((b) => b.kind === 'hotfix' || finalsOf(b.major, b.minor).length === 0);
const lastRcOf = (line) => pendingRcs(line.major, line.minor).at(-1);

// Without a tag, by what the run starts from: --branch (the rc job's test deploy), else the run's
// ref (a tag deploys that tag; a line deploys its last rc), else the only open line. For a test
// stage, a --branch with no rc yet (a fresh cut, which takes no rc until new code lands) gives null.
function defaultDeployTag(stage) {
  if (opts.branch) {
    const line = parseLine(opts.branch);
    if (!line) fail(`"${opts.branch}" is not a version line`);
    const last = lastRcOf(line);
    if (!last && stage === 'test') return null;
    if (!last) fail(`${line.name} has no rc to deploy`);
    return last.name;
  }
  const refName = process.env.GITHUB_REF_NAME;
  if (process.env.GITHUB_REF_TYPE === 'tag' && refName) return refName;
  const ref = parseLine(refName);
  const open = ref ? [ref] : openLines();
  if (open.length > 1) {
    const list = open.map((l) => `${l.name}: ${lastRcOf(l)?.name ?? 'no rc'}`).join(', ');
    fail(`${open.length} lines are open (${list}); pass the tag or run from the line's branch`);
  }
  if (!open.length) fail('no open line; pass the tag to deploy');
  const last = lastRcOf(open[0]);
  if (!last) fail(`${open[0].name} has no rc to deploy`);
  return last.name;
}

async function cmdDeploy() {
  const stage = opts.stage || 'test';
  if (stage !== 'test' && stage !== 'prod') fail(`--stage must be test or prod, got "${stage}"`);
  const apps = stageApps(stage);
  const varName = stage === 'prod' ? 'DEPLOY_PROD_APPS' : 'DEPLOY_TEST_APPS';
  if (!apps.length) { log(`✓ no ${stage} apps (${varName} is empty); nothing to deploy`); return; }
  const name = opts._[0] || opts.tag || defaultDeployTag(stage);
  if (!name) {
    log(`✓ ${opts.branch} has no rc yet; nothing to deploy`);
    summary(`Nothing deployed to ${stage}: \`${opts.branch}\` has no rc yet`);
    return;
  }
  checkDeploy(name, stage === 'prod');
  log(`deploying ${name} to ${stage}: ${apps.join(' → ')}`);
  await deployTag(name, apps);
  const targets = apps.map((a) => `\`${a}\``).join(', ');
  outcome(`Deployed **${name}** to ${stage}: ${targets}`, `deploy **${name}** to ${stage}: ${targets}`);
}

function cmdStatus() {
  const def = defaultBranch();
  const { tags, branches } = state();
  const prod = prodTag();
  log(`repository:     ${repoSlug() ?? '(unknown)'}`);
  log(`default branch: ${def}`);
  log(`in prod:        ${prod?.name ?? 'nothing (no final tag on the default branch)'}`);
  log(`tags:           ${tags.map((t) => t.name).join(', ') || 'none'}`);
  for (const b of branches) {
    const shipped = finalsOf(b.major, b.minor);
    const open = b.kind === 'hotfix' || !shipped.length;
    if (!open) { log(`  ${b.name}: shipped (${shipped.map((t) => t.name).join(', ')})`); continue; }
    if (b.kind === 'hotfix' && !shipped.length) { log(`  ${b.name}: ⚠ no final v${b.major}.${b.minor}.* to fix`); continue; }
    const last = pendingRcs(b.major, b.minor).at(-1);
    log(`  ${b.name}: open, last rc ${last?.name ?? 'none'}, next rc ${rcName(b, nextPatch(b.major, b.minor))}`);
  }
  const manual = lines(git('for-each-ref', '--format=%(refname:strip=2)|%(taggername)', 'refs/tags'))
    .map((l) => l.split('|')).filter(([n, tagger]) => parseTag(n) && tagger !== BOT_NAME).map(([n]) => n);
  if (manual.length) warn(`tags not created by the automation: ${manual.join(', ')}`);
}

// ---------- failure issues ----------

const REPORT_JOBS = ['rc', 'deploy-test', 'final', 'cleanup'];
const REPORT_LABEL = 'release-kit';

// The issue body (and each later failure's comment): the run, the line, the error, where to look.
function failureBody(job, line, runUrl, error) {
  const text = error || '(no message from release.mjs: see the run)';
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((b) => b.length));
  const fence = '`'.repeat(longest + 1);
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const guide = `${server}/${repoSlug()}/blob/${defaultBranch()}/RELEASING.md#when-the-automation-refuses`;
  return [
    `The \`${job}\` job failed on \`${line}\`: ${runUrl}`,
    '',
    fence, text, fence,
    '',
    `What to do: [RELEASING.md, "When the automation refuses"](${guide}).`,
    `The next successful \`${job}\` on \`${line}\` closes this issue.`,
  ].join('\n');
}

async function reportResult(job, line, result, runUrl, error) {
  const title = `Release automation failing: ${job} on ${line}`;
  if (dryRun && !token()) {
    log('  (no GitHub token: skipping the check for an open issue)');
    act(result === 'failure' ? `open issue "${title}"` : `close issue "${title}" if one is open`);
    return;
  }
  const issues = await api('GET', `/issues?state=open&labels=${REPORT_LABEL}&per_page=100`);
  const open = issues.find((i) => i.title === title && !i.pull_request) ?? null;
  if (result === 'failure') {
    const body = failureBody(job, line, runUrl, error);
    if (open) {
      act(`comment on issue #${open.number} ("${title}")`);
      if (dryRun) return;
      await api('POST', `/issues/${open.number}/comments`, { body });
      log(`✓ commented on issue #${open.number}: ${title}`);
    } else {
      act(`open issue "${title}"`);
      if (dryRun) return;
      const issue = await api('POST', '/issues', { title, body, labels: [REPORT_LABEL] });
      log(`✓ opened issue #${issue.number}: ${title}`);
    }
    return;
  }
  if (!open) { log(`✓ no open issue for ${job} on ${line}`); return; }
  act(`close issue #${open.number} ("${title}")`);
  if (dryRun) return;
  await api('POST', `/issues/${open.number}/comments`, { body: `Fixed by ${runUrl}` });
  await api('PATCH', `/issues/${open.number}`, { state: 'closed', state_reason: 'completed' });
  log(`✓ closed issue #${open.number}: ${title}`);
}

// The job already passed or failed: reporting it never changes that, so a GitHub error is a warning.
async function cmdReport() {
  const { job, line, result } = opts;
  const runUrl = opts['run-url'];
  const error = typeof opts.error === 'string' ? opts.error : '';
  if (!REPORT_JOBS.includes(job)) fail(`--job must be ${REPORT_JOBS.slice(0, -1).join(', ')} or ${REPORT_JOBS.at(-1)}`);
  if (!['success', 'failure', 'skipped', 'cancelled'].includes(result)) {
    fail('--result must be success, failure, skipped or cancelled');
  }
  // A skipped job may have no line (final and cleanup on a push): nothing to look up.
  if (result === 'skipped' || result === 'cancelled') { log(`nothing to report: ${job} was ${result}`); return; }
  if (typeof line !== 'string' || !line) fail('--line is required (the branch the job ran for)');
  if (typeof runUrl !== 'string' || !runUrl) fail('--run-url is required');
  try {
    await reportResult(job, line, result, runUrl, error);
  } catch (err) {
    if (!(err instanceof Failure)) throw err;
    warn(`could not report ${job} on ${line} (${result}): ${err.message}`);
  }
}

const COMMANDS = {
  rc: cmdRc, sync: cmdSync, final: cmdFinal, 'cut-release': cmdCutRelease, 'cut-hotfix': cmdCutHotfix,
  conventions: cmdConventions, cleanup: cmdCleanup, 'deploy-check': cmdDeployCheck, deploy: cmdDeploy,
  status: cmdStatus, report: cmdReport,
};

try {
  if (!COMMANDS[cmd]) fail(`usage: release.mjs <${Object.keys(COMMANDS).join('|')}> [--dry-run] [options]`);
  if (dryRun) log('[dry-run] nothing will be pushed, tagged or opened');
  await COMMANDS[cmd]();
} catch (err) {
  const msg = err instanceof Failure ? err.message : (err.stderr?.toString().trim() || err.stack);
  console.error(inActions ? `::error::${msg}` : `error: ${msg}`);
  // For the report job (needs.<job>.outputs.error): one line, the message without a stack.
  const short = err instanceof Failure ? err.message : (err.stderr?.toString().trim() || err.message || String(err));
  output('error', short.replace(/\s*\n\s*/g, ' ').trim());
  process.exitCode = 1;
}
