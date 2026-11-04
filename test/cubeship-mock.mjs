#!/usr/bin/env node
// A tiny stand-in for the Cubeship API, for test/fixtures.sh. Usage: cubeship-mock.mjs <port> <git-dir>
// Apps build from Git; a deploy "builds" the app's ref by resolving it in <git-dir> and succeeds.
// Like Cubeship, PATCH refuses a ref without the source and repo it goes with. A deploy stays
// pending for its first two reads, and a long-poll (?wait=true) on a pending deploy is dropped,
// like the real connection that a proxy cuts after a few minutes.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const [port, gitDir] = process.argv.slice(2);
const apps = new Map();
const deploys = new Map();
let nextId = 1;
for (const ref of ['demo/test/api', 'demo/test/web', 'demo/prod/api', 'demo/prod/web']) {
  apps.set(ref, { source: 'dockerfile', repo: 'https://github.com/example/fixture', dockerfile: 'Dockerfile', ref: 'main' });
  deploys.set(ref, []);
}
const shaOf = (ref) => execFileSync('git', ['-C', gitDir, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer test-key') return send(401, { error: 'bad key' });
    const url = new URL(req.url, 'http://mock');
    const m = /^\/apps\/([^/]+)\/([^/]+)\/([^/]+)(\/deploy|\/deployments(?:\/(\d+))?)?$/.exec(url.pathname);
    if (!m) return send(404, { error: 'no route' });
    const ref = `${m[1]}/${m[2]}/${m[3]}`;
    const app = apps.get(ref);
    if (!app) return send(404, { error: `no app ${ref}` });
    const json = body ? JSON.parse(body) : {};
    if (!m[4] && req.method === 'GET') return send(200, { name: m[3], ...app });
    if (!m[4] && req.method === 'PATCH') {
      if (json.ref && (!json.source || !json.repo)) return send(400, { error: 'a building app needs the Git repository it builds from' });
      Object.assign(app, json);
      console.error(`[mock] ${ref} ref → ${app.ref}`);
      return send(200, { name: m[3], ...app });
    }
    if (m[4] === '/deploy' && req.method === 'POST') {
      const d = { id: nextId++, status: 'pending', reads: 0, git_branch: app.ref, git_sha: shaOf(app.ref), duration_ms: 1000, image: 'x', has_logs: false, created_at: new Date().toISOString() };
      deploys.get(ref).unshift(d);
      console.error(`[mock] ${ref} deploy #${d.id} of ${app.ref}`);
      return send(202, d);
    }
    // The real API answers a bare array, newest first (the MCP tools wrap it in { items }).
    if (m[4] === '/deployments' && req.method === 'GET') return send(200, deploys.get(ref));
    if (m[5] && req.method === 'GET') {
      const d = deploys.get(ref).find((x) => x.id === Number(m[5]));
      if (!d) return send(404, { error: 'no deploy' });
      if (d.status === 'pending' && url.searchParams.get('wait') === 'true') return req.socket.destroy();
      if (d.status === 'pending' && ++d.reads >= 2) d.status = 'succeeded';
      return send(200, d);
    }
    return send(405, { error: 'method' });
  });
}).listen(Number(port), '127.0.0.1');
