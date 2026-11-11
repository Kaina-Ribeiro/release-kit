// The Cubeship deploy adapter: points each app (project/environment/app) at the tag, deploys it,
// waits for the build, then checks that its container comes up and stays up (see waitForHealthy).
// Reads DEPLOY_URL and DEPLOY_TOKEN, else CUBESHIP_URL and CUBESHIP_TOKEN (installs from before
// the adapters). RELEASE_HEALTH_STABLE_S and RELEASE_HEALTH_WAIT_S tune the health check.
// Loaded by release.mjs only for a deploy or the final's check that prod runs the rc.

// Apps that build from Git, whose `ref` can point at a tag.
const BUILDING_SOURCES = new Set(['dockerfile', 'railpack']);
const DEPLOY_WAIT_MS = 45 * 60 * 1000;
const DEPLOY_POLL_MS = Number(process.env.RELEASE_DEPLOY_POLL_MS) || 10_000;
const MAX_POLL_ERRORS = 6;
const HEALTH_POLL_MS = Number(process.env.RELEASE_HEALTH_POLL_MS) || 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const baseUrl = () => process.env.DEPLOY_URL || process.env.CUBESHIP_URL || '';
const apiToken = () => process.env.DEPLOY_TOKEN || process.env.CUBESHIP_TOKEN || '';

export default function create({ dryRun, log, act, warn, fail, Failure, commitOf }) {
  async function cubeship(method, path, body) {
    const base = baseUrl().replace(/\/+$/, '');
    if (!base) fail('set DEPLOY_URL to the Cubeship API, e.g. https://cubeship.example.com/api');
    if (!apiToken()) fail('set the DEPLOY_TOKEN secret (a Cubeship API key)');
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiToken()}`,
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
            + 'Give the DEPLOY_TOKEN key view on servers (the Deploy role has it), or set RELEASE_HEALTH_STABLE_S=0 to skip the check.');
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

  // Points the app at the tag and deploys it; ends once its container stays up.
  async function deploy(ref, tag) {
    const app = await getBuildingApp(ref);
    if (await runs(ref, app, tag)) {
      // A re-run of a failed job lands here too: "succeeded" in Cubeship says nothing about now.
      if (!dryRun) await waitForHealthy(ref, await lastDeployment(ref));
      log(`✓ ${ref} already runs ${tag}`);
      return;
    }
    // A re-run after a dropped wait: that deploy of this tag is still going, so wait for it.
    const last = app.ref === tag ? await lastDeployment(ref) : null;
    if (!dryRun && last?.status === 'pending' && last.git_sha === commitOf(tag)) {
      log(`${ref} is already deploying ${tag} (deploy #${last.id}); waiting for it`);
      const done = await waitForDeploy(ref, last.id);
      await waitForHealthy(ref, done);
      log(`✓ ${ref} runs ${tag} (deploy #${done.id})`);
      return;
    }
    act(`set ${ref} to ${tag} (was ${app.ref}) and deploy it`);
    if (dryRun) return;
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

  return {
    name: 'cubeship',
    missing: 'DEPLOY_URL and DEPLOY_TOKEN',
    configured: () => Boolean(baseUrl() && apiToken()),
    deploy,
    async runs(ref, tag) {
      const app = await getBuildingApp(ref);
      return { runs: await runs(ref, app, tag), current: app.ref };
    },
  };
}
