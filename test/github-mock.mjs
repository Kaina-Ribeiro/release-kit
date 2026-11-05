#!/usr/bin/env node
// A tiny stand-in for the GitHub REST API, for test/fixtures.sh. Usage: github-mock.mjs <port> <dir>
// Pull requests, PR comments and releases, in memory, for any /repos/<owner>/<repo>. Requires
// `authorization: Bearer test-token`. Each change is appended to <dir>/log (`pull #2 main ->
// release/v0.2`, `comment #1: <body>`, `release v0.1.1`), for the fixtures to check. While
// <dir>/refuse-pulls-from holds a branch name, opening a PR from that branch answers 403, like a
// repository whose settings do not let GitHub Actions create pull requests. If <dir>/fail-next-release
// exists, the next release creation answers 500 and removes the file (a GitHub outage after a tag).
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, dir] = process.argv.slice(2);
const pulls = [];
const releases = new Map(); // tag → release
writeFileSync(join(dir, 'log'), '');
const record = (line) => appendFileSync(join(dir, 'log'), `${line}\n`);
const refusedHead = () => {
  const file = join(dir, 'refuse-pulls-from');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
};

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { message: 'Bad credentials' });
    const url = new URL(req.url, 'http://mock');
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) return send(404, { message: 'Not Found' });
    const [, owner, , path] = m;
    const input = body ? JSON.parse(body) : {};

    if (path === '/pulls' && req.method === 'GET') {
      const head = url.searchParams.get('head');
      const base = url.searchParams.get('base');
      return send(200, pulls.filter((p) => p.state === (url.searchParams.get('state') ?? 'open')
        && (!head || `${owner}:${p.head}` === head) && (!base || p.base === base)));
    }
    if (path === '/pulls' && req.method === 'POST') {
      if (input.head === refusedHead()) {
        record(`refused pull ${input.head} -> ${input.base}`);
        return send(403, { message: 'GitHub Actions is not permitted to create or approve pull requests.' });
      }
      const pr = { number: pulls.length + 1, state: 'open', title: input.title, head: input.head, base: input.base };
      pulls.push(pr);
      record(`pull #${pr.number} ${pr.head} -> ${pr.base}`);
      return send(201, pr);
    }
    const comment = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (comment && req.method === 'POST') {
      if (!pulls.some((p) => p.number === +comment[1])) return send(404, { message: 'Not Found' });
      record(`comment #${comment[1]}: ${input.body}`);
      return send(201, { id: Date.now() });
    }
    if (path === '/releases/generate-notes' && req.method === 'POST') return send(200, { body: `notes for ${input.tag_name}` });
    const byTag = /^\/releases\/tags\/(.+)$/.exec(path);
    if (byTag && req.method === 'GET') {
      const release = releases.get(decodeURIComponent(byTag[1]));
      return release ? send(200, release) : send(404, { message: 'Not Found' });
    }
    if (path === '/releases' && req.method === 'POST') {
      const failFile = join(dir, 'fail-next-release');
      if (existsSync(failFile)) {
        rmSync(failFile);
        record(`failed release ${input.tag_name}`);
        return send(500, { message: 'Server Error' });
      }
      if (releases.has(input.tag_name)) return send(422, { message: 'Validation Failed: tag_name already_exists' });
      const release = { id: releases.size + 1, tag_name: input.tag_name, prerelease: Boolean(input.prerelease) };
      releases.set(input.tag_name, release);
      record(`release ${input.tag_name}${input.prerelease ? ' (prerelease)' : ''}`);
      return send(201, release);
    }
    return send(404, { message: 'Not Found' });
  });
}).listen(Number(port), '127.0.0.1');
