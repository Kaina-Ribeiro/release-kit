#!/usr/bin/env node
// Release automation for the version-line flow described in RELEASING.md.
// Zero dependencies, Node 18+. Installed into a repo as .github/scripts/release.mjs.
//
//   rc           tag vX.Y.Z-rc on a push to release/vX.Y or hotfix/vX.Y, plus a prerelease;
//                every new candidate takes the next patch (v0.2.0-rc, v0.2.1-rc, …)
//   sync         open "chore(sync): merge A into B" into the next open release line
//   final        tag the line's last rc as final (v0.2.1-rc → v0.2.1) on the merge of a version line
//                into the default branch, plus a release; refuses when prod does not run that rc
//                (if DEPLOY_PROD_APPS is set); then deletes the shipped line's branch
//   cut-release  create the next release/vX.Y from the newest open release (or the default branch)
//   cut-hotfix   create hotfix/vX.Y from the final tag in prod
//   conventions  check a PR's branch name, title and target (used by the PR checks workflow)
//   cleanup      delete a feature/fix branch once its PR is merged into a version line
//                (version lines and the default branch are never deleted here)
//   deploy-check gate a deploy: any release tag for test stages; --prod only for the last rc of an
//                open line, or a final whose code equals its rc (rollback)
//   deploy       deploy a release tag to the test or prod apps on Cubeship (passes deploy-check first)
//   status       print the release state of the repo (read-only)
//
// Flags: --dry-run (print, change nothing), --no-fetch, --branch, --sha, --head, --version,
//        --title, --base, --prod, --stage, --apps. Env: DEFAULT_BRANCH, GITHUB_REPOSITORY,
//        GH_TOKEN/GITHUB_TOKEN, TICKET_PATTERN, PR_TITLE, HEAD_REF, BASE_REF, HEAD_SHA,
//        CUBESHIP_URL, CUBESHIP_TOKEN, DEPLOY_TEST_APPS, DEPLOY_PROD_APPS.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'chore', 'refactor', 'perf', 'docs', 'test', 'ci', 'build', 'revert'];
const LINE_RE = /^(release|hotfix)\/v(\d+)\.(\d+)$/;
// vX.Y.Z-rc is a candidate; vX.Y.Z-rc.N is the legacy candidate format, still read but never written.
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-rc(?:\.(\d+))?)?$/;
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

// ---------- git ----------

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  // rc: null for a final, 0 for vX.Y.Z-rc, N for the legacy vX.Y.Z-rc.N.
  return { name, major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] === undefined ? null : +(m[5] ?? 0) };
}
function parseLine(name) {
  const m = LINE_RE.exec(name ?? '');
  return m ? { name, kind: m[1], major: +m[2], minor: +m[3] } : null;
}
function cmpTag(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
    || (a.rc ?? Number.MAX_SAFE_INTEGER) - (b.rc ?? Number.MAX_SAFE_INTEGER);
}
const cmpLine = (a, b) => a.major - b.major || a.minor - b.minor;
const fmt = (major, minor, patch) => `v${major}.${minor}.${patch}`;
const fmtRc = (major, minor, patch) => `${fmt(major, minor, patch)}-rc`;

let stateCache;
function state() {
  if (stateCache) return stateCache;
  if (!opts['no-fetch']) git('fetch', 'origin', '--tags', '--prune', '--quiet');
  const tags = lines(git('tag', '--list', 'v*')).map(parseTag).filter(Boolean).sort(cmpTag);
  const branches = lines(git('for-each-ref', '--format=%(refname:strip=3)',
    'refs/remotes/origin/release', 'refs/remotes/origin/hotfix')).map(parseLine).filter(Boolean).sort(cmpLine);
  return (stateCache = { tags, branches });
}

const finalsOf = (major, minor) => state().tags.filter((t) => t.rc === null && t.major === major && t.minor === minor);
const rcsOf = (major, minor, patch) =>
  state().tags.filter((t) => t.rc !== null && t.major === major && t.minor === minor && t.patch === patch);
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

async function api(method, path, body) {
  const slug = repoSlug();
  if (!slug) fail('cannot tell the GitHub repository; set GITHUB_REPOSITORY=owner/name');
  if (!token()) fail('GitHub API needs GH_TOKEN or GITHUB_TOKEN');
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetch(`${base}/repos/${slug}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token()}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
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
    warn(`could not delete ${name} (${err.stderr?.toString().trim() || err.message}); delete it by hand`);
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

async function openSyncPr(source, target) {
  const title = `chore(sync): merge ${source} into ${target}`;
  const owner = (repoSlug() ?? '').split('/')[0];
  if (token() && owner) {
    const open = await api('GET', `/pulls?state=open&head=${owner}:${encodeURIComponent(source)}`
      + `&base=${encodeURIComponent(target)}`);
    if (open.length) { log(`✓ sync PR already open: #${open[0].number} ${title}`); return; }
  } else if (dryRun) {
    log('  (no GitHub token: skipping the check for an already-open sync PR)');
  }
  act(`open PR "${title}"`);
  if (dryRun) return;
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

async function lastDeployment(ref) {
  const res = await cubeship('GET', `${appPath(ref)}/deployments`);
  return (res?.items ?? [])[0] ?? null;
}

// True when the app is set to `tag` and its latest deploy built that commit successfully.
async function runs(ref, app, tag) {
  if (app.ref !== tag) return false;
  const last = await lastDeployment(ref);
  return Boolean(last && last.status === 'succeeded' && last.git_sha === commitOf(tag));
}

async function waitForDeploy(ref, id) {
  const started = Date.now();
  for (;;) {
    const d = await cubeship('GET', `${appPath(ref)}/deployments/${id}?wait=true`);
    if (d.status === 'succeeded') return d;
    if (d.status === 'failed' || d.cancelled) fail(`deploy #${id} of ${ref} failed: ${d.error || d.status}`);
    if (d.status === 'skipped') return d;
    if (Date.now() - started > DEPLOY_WAIT_MS) fail(`deploy #${id} of ${ref} still ${d.status} after 45 min`);
  }
}

// Points each app at the tag and deploys it, in the listed order (e.g. api before web).
async function deployTag(tag, apps) {
  for (const ref of apps) {
    if (dryRun && !hasCubeship()) { act(`set ${ref} to ${tag} and deploy it`); continue; }
    const app = await getBuildingApp(ref);
    if (await runs(ref, app, tag)) { log(`✓ ${ref} already runs ${tag}`); continue; }
    act(`set ${ref} to ${tag} (was ${app.ref}) and deploy it`);
    if (dryRun) continue;
    // The source and its settings travel together, so the source, repo and recipe go with the ref.
    await cubeship('PATCH', appPath(ref), {
      source: app.source, repo: app.repo, ref: tag, ...(app.dockerfile ? { dockerfile: app.dockerfile } : {}),
    });
    const started = await cubeship('POST', `${appPath(ref)}/deploy`, {});
    const done = await waitForDeploy(ref, started.id);
    log(`✓ ${ref} runs ${tag} (deploy #${done.id}, ${Math.round((done.duration_ms ?? 0) / 1000)}s)`);
  }
}

// ---------- commands ----------

const currentBranch = () => opts.branch || process.env.GITHUB_REF_NAME || git('branch', '--show-current');
const shaOf = (branch) => opts.sha || process.env.GITHUB_SHA || commitOf(branchExists(branch) ? remoteRef(branch) : branch);

async function cmdRc() {
  const branch = currentBranch();
  const line = checkLine(branch);
  const sha = shaOf(branch);
  const rcs = pendingRcs(line.major, line.minor);
  const already = rcs.find((r) => commitOf(r.name) === sha);
  if (already) { log(`✓ ${sha.slice(0, 12)} is already ${already.name}; nothing to do`); return; }
  const last = rcs.at(-1);
  const tag = fmtRc(line.major, line.minor, nextPatch(line.major, line.minor));
  const previous = last?.name ?? finals().filter((f) => cmpTag(f, parseTag(tag)) < 0).at(-1)?.name;
  log(`${branch} → ${tag} (${last ? `last rc ${last.name}` : 'first rc'})`);
  createTag(tag, sha, `Release candidate ${tag} from ${branch}`);
  await createRelease(tag, sha, previous, true);
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
    deleteBranch(head);
    return;
  }
  checkLine(head);
  const lastRc = pendingRcs(line.major, line.minor).at(-1);
  if (!lastRc) fail(`${head} has no rc since ${shipped?.name ?? 'it was cut'}: it was never tested as a release candidate; not tagging a final`);
  const tag = fmt(lastRc.major, lastRc.minor, lastRc.patch);
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
  deleteBranch(head);
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
  log(`open releases: ${open.map((r) => r.name).join(', ') || 'none'}; latest shipped: ${shipped?.name ?? 'none'}`);
  log(`${branch} branches from ${from}; its first rc will be ${fmtRc(major, minor, 0)}`);
  createBranch(branch, commitOf(remoteRef(from)));
  outcome(`Cut **${branch}** from \`${from}\``, `cut **${branch}** from \`${from}\``);
}

async function cmdCutHotfix() {
  const prod = prodTag();
  if (!prod) fail(`no final vX.Y.Z tag on ${defaultBranch()}: nothing in prod to hotfix`);
  const branch = `hotfix/v${prod.major}.${prod.minor}`;
  const next = fmtRc(prod.major, prod.minor, nextPatch(prod.major, prod.minor));
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
    if (base !== def && !parseLine(base)) {
      errors.push(`${head} can only merge into ${def} or another version line, not "${base}"`);
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
  if (!tag) fail(`"${name}" is not a release tag (vX.Y.Z or vX.Y.Z-rc); branches and other refs never deploy`);
  if (!gitOk('rev-parse', '--verify', '--quiet', `refs/tags/${name}`)) fail(`tag ${name} does not exist`);
  if (!prod) { log(`✓ ${name} can go to a test stage`); return tag; }
  if (tag.rc !== null) {
    const last = pendingRcs(tag.major, tag.minor).at(-1);
    if (last?.name !== name) {
      fail(`${name} is not the last rc of an open v${tag.major}.${tag.minor} line`
        + `${last ? ` (that is ${last.name})` : ''}; prod takes only the line's last rc or a final`);
    }
    log(`✓ ${name} can go to prod (last rc of v${tag.major}.${tag.minor}; the merge will tag it ${fmt(tag.major, tag.minor, tag.patch)})`);
    return tag;
  }
  const lastRc = rcsOf(tag.major, tag.minor, tag.patch).at(-1);
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
  if (!name) fail('deploy-check needs a tag: deploy-check vX.Y.Z[-rc] [--prod]');
  checkDeploy(name, Boolean(opts.prod));
}

// Without a tag: the last rc of --branch, else of the newest open release line.
function defaultDeployTag() {
  const line = opts.branch ? parseLine(opts.branch) : openReleases().at(-1);
  if (!line) fail(opts.branch ? `"${opts.branch}" is not a version line` : 'no open release line; pass the tag to deploy');
  const last = pendingRcs(line.major, line.minor).at(-1);
  if (!last) fail(`${line.name} has no rc to deploy`);
  return last.name;
}

async function cmdDeploy() {
  const stage = opts.stage || 'test';
  if (stage !== 'test' && stage !== 'prod') fail(`--stage must be test or prod, got "${stage}"`);
  const apps = stageApps(stage);
  const varName = stage === 'prod' ? 'DEPLOY_PROD_APPS' : 'DEPLOY_TEST_APPS';
  if (!apps.length) { log(`✓ no ${stage} apps (${varName} is empty); nothing to deploy`); return; }
  const name = opts._[0] || opts.tag || defaultDeployTag();
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
    log(`  ${b.name}: open, last rc ${last?.name ?? 'none'}, next rc ${fmtRc(b.major, b.minor, nextPatch(b.major, b.minor))}`);
  }
  const manual = lines(git('for-each-ref', '--format=%(refname:strip=2)|%(taggername)', 'refs/tags'))
    .map((l) => l.split('|')).filter(([n, tagger]) => parseTag(n) && tagger !== BOT_NAME).map(([n]) => n);
  if (manual.length) warn(`tags not created by the automation: ${manual.join(', ')}`);
}

const COMMANDS = {
  rc: cmdRc, sync: cmdSync, final: cmdFinal, 'cut-release': cmdCutRelease, 'cut-hotfix': cmdCutHotfix,
  conventions: cmdConventions, cleanup: cmdCleanup, 'deploy-check': cmdDeployCheck, deploy: cmdDeploy,
  status: cmdStatus,
};

try {
  if (!COMMANDS[cmd]) fail(`usage: release.mjs <${Object.keys(COMMANDS).join('|')}> [--dry-run] [options]`);
  if (dryRun) log('[dry-run] nothing will be pushed, tagged or opened');
  await COMMANDS[cmd]();
} catch (err) {
  const msg = err instanceof Failure ? err.message : (err.stderr?.toString().trim() || err.stack);
  console.error(inActions ? `::error::${msg}` : `error: ${msg}`);
  process.exitCode = 1;
}
