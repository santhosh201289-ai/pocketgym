// POST /api/ingest/activity end to end: the token from Settings, and nothing but that token, adds
// a day to the stored document and moves its revision; the token can do nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'test-secret-ingest';
const uid = 'u_ingest_1';
const session = () => { const p = `${uid}:${Date.now() + 86400000}:0`; return `${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };

test('ingest token and POST /api/ingest/activity', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-ingest-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: uid, name: 'I', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;

  const signedIn = { cookie: `gymsid=${session()}`, origin: 'http://localhost:8080', 'content-type': 'application/json' };
  const ingest = (token, body) => fetch(`${base}/api/ingest/activity`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const today = new Date().toISOString().slice(0, 10);

  assert.equal((await fetch(`${base}/api/ingest/token`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/ingest/token`, { headers: signedIn })).json(), { on: false });

  const made = await (await fetch(`${base}/api/ingest/token`, { method: 'POST', headers: signedIn })).json();
  assert.match(made.token, /^pgi_/);
  const status = await (await fetch(`${base}/api/ingest/token`, { headers: signedIn })).json();
  assert.equal(status.on, true);
  assert.equal(status.token, undefined, 'the token is shown once, never read back');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8').includes(made.token), 'only its hash is stored');

  // Before the profile has a document there is nothing to add to.
  assert.equal((await ingest(made.token, { steps: 100 })).status, 409);
  const put = await fetch(`${base}/api/data`, { method: 'PUT', headers: signedIn, body: JSON.stringify({ state: { workouts: [], routines: [], activity: [] }, baseRev: 0, stamped: true }) });
  assert.equal(put.status, 200);

  // A wrong token, a session token, nothing at all.
  assert.equal((await ingest('pgi_nope', { steps: 1 })).status, 401);
  assert.equal((await ingest(session(), { steps: 1 })).status, 401);
  assert.equal((await fetch(`${base}/api/ingest/activity`, { method: 'POST', headers: signedIn, body: '{"steps":1}' })).status, 401, 'a cookie is not enough');

  const r = await ingest(made.token, { date: today, steps: '8,123', sleepHours: 7 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, days: 1, sessions: 0, rev: 2 });
  const got = await (await fetch(`${base}/api/data`, { headers: signedIn })).json();
  assert.equal(got.rev, 2);
  assert.deepEqual(got.state.activity.map(({ t, ...e }) => e), [{ d: today, steps: 8123, sleepMin: 420, src: 'iPhone' }]);

  // The same again: nothing changed, no new revision.
  assert.deepEqual(await (await ingest(made.token, { date: today, steps: 8123 })).json(), { ok: true, days: 0, sessions: 0, rev: 2 });
  assert.equal((await ingest(made.token, { hello: 'world' })).status, 400);

  // The token cannot read the profile.
  assert.equal((await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${made.token}` } })).status, 401);

  // A new token retires the old one; turning it off retires both.
  const second = await (await fetch(`${base}/api/ingest/token`, { method: 'POST', headers: signedIn })).json();
  assert.equal((await ingest(made.token, { steps: 1 })).status, 401);
  assert.equal((await ingest(second.token, { date: today, steps: 9000 })).status, 200);
  assert.equal((await fetch(`${base}/api/ingest/token`, { method: 'DELETE', headers: signedIn })).status, 200);
  assert.equal((await ingest(second.token, { steps: 1 })).status, 401);
});
