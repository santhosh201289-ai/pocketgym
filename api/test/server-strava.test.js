// Strava end to end, against a stand-in Strava: connect, the callback, the first sync into the
// stored document, sync again, disconnect. And the callback refuses a state it did not hand out
// to this same profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'test-secret-strava';
const sid = uid => { const p = `${uid}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };

function fakeStrava() {
  const seen = [];
  const acts = [
    { id: 1, name: 'Morning Run', sport_type: 'Run', start_date: new Date(Date.now() - 2 * 86400000).toISOString(), utc_offset: 19800, moving_time: 1800, distance: 5000, average_heartrate: 150 },
    { id: 2, name: 'Gym', sport_type: 'WeightTraining', start_date: new Date(Date.now() - 86400000).toISOString(), moving_time: 3600 },
  ];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/oauth/token') {
        const p = new URLSearchParams(body);
        if (p.get('client_secret') !== 'sec') return send(401, { message: 'Authorization Error' });
        return send(200, { access_token: 'acc', refresh_token: 'ref', expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: { id: 77, firstname: 'Asha', lastname: 'K' } });
      }
      if (req.url === '/oauth/deauthorize') return send(200, { access_token: 'acc' });
      if (req.url.startsWith('/api/v3/athlete/activities')) {
        if (req.headers.authorization !== 'Bearer acc') return send(401, {});
        return send(200, new URL(req.url, 'http://x').searchParams.get('page') === '1' ? acts : []);
      }
      send(404, {});
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, acts, base: `http://127.0.0.1:${server.address().port}` })));
}

test('Strava: connect, sync, disconnect', async t => {
  const strava = await fakeStrava();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-strava-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u_s1', name: 'S' }, { id: 'u_s2', name: 'T' }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost',
      STRAVA_CLIENT_ID: '42', STRAVA_CLIENT_SECRET: 'sec', STRAVA_OAUTH_BASE: strava.base, STRAVA_API_BASE: strava.base + '/api/v3',
    },
  });
  t.after(() => { child.kill('SIGKILL'); strava.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const h = uid => ({ cookie: sid(uid), origin: 'http://localhost:8080', 'content-type': 'application/json' });
  const status = async (uid = 'u_s1') => (await fetch(`${base}/api/strava/status`, { headers: h(uid) })).json();

  assert.deepEqual(await status(), { available: true, connected: false });
  await fetch(`${base}/api/data`, { method: 'PUT', headers: h('u_s1'), body: JSON.stringify({ state: { workouts: [], routines: [], sessions: [] }, baseRev: 0, stamped: true }) });

  // Signed out: back to the app, not to Strava.
  const anon = await fetch(`${base}/api/strava/connect`, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '../../#/settings/data');

  const go = await fetch(`${base}/api/strava/connect`, { headers: h('u_s1'), redirect: 'manual' });
  assert.equal(go.status, 302);
  const to = new URL(go.headers.get('location'));
  assert.equal(to.origin, strava.base);
  assert.equal(to.searchParams.get('redirect_uri'), 'http://localhost:8080/api/strava/callback');
  const state = to.searchParams.get('state');

  const callback = (uid, q) => fetch(`${base}/api/strava/callback?${new URLSearchParams(q)}`, { headers: h(uid), redirect: 'manual' });
  // Someone else's browser coming back with this state: refused, and the state is spent.
  assert.equal((await callback('u_s2', { state, code: 'c', scope: 'read,activity:read_all' })).headers.get('location'), '../../#/settings/data?strava=expired');
  const go2 = await fetch(`${base}/api/strava/connect`, { headers: h('u_s1'), redirect: 'manual' });
  const state2 = new URL(go2.headers.get('location')).searchParams.get('state');
  // The activity scope unticked on Strava's screen.
  assert.equal((await callback('u_s1', { state: state2, code: 'c', scope: 'read' })).headers.get('location'), '../../#/settings/data?strava=scope');

  const go3 = await fetch(`${base}/api/strava/connect`, { headers: h('u_s1'), redirect: 'manual' });
  const state3 = new URL(go3.headers.get('location')).searchParams.get('state');
  const ok = await callback('u_s1', { state: state3, code: 'c0de', scope: 'read,activity:read_all' });
  assert.equal(ok.headers.get('location'), '../../#/settings/data?strava=connected');

  // The first sync runs behind the redirect; an explicit one waits for it.
  const sync = await (await fetch(`${base}/api/strava/sync`, { method: 'POST', headers: h('u_s1'), body: '{}' })).json();
  assert.equal(sync.ok, true);
  const st = await status();
  assert.equal(st.connected, true);
  assert.equal(st.athlete, 'Asha K');
  assert.equal(st.count, 1);
  assert.equal(st.error, null);

  const data = await (await fetch(`${base}/api/data`, { headers: h('u_s1') })).json();
  assert.equal(data.state.sessions.length, 1, 'the run, not the strength session');
  const [run] = data.state.sessions;
  assert.equal(run.type, 'run');
  assert.equal(run.src, 'Strava');
  assert.equal(run.srcId, '1');
  assert.equal(run.distM, 5000);
  assert.ok(run._ts > 0);
  const db = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  assert.ok(!db.includes('"sec"'), 'the client secret is never written to db.json');

  // Again: nothing new.
  const again = await (await fetch(`${base}/api/strava/sync`, { method: 'POST', headers: h('u_s1'), body: '{}' })).json();
  assert.equal(again.sessions, 0);

  // Another profile cannot sync or see this one's link.
  assert.deepEqual(await status('u_s2'), { available: true, connected: false });
  assert.equal((await fetch(`${base}/api/strava/sync`, { method: 'POST', headers: h('u_s2'), body: '{}' })).status, 409);

  assert.equal((await fetch(`${base}/api/strava`, { method: 'DELETE', headers: h('u_s1') })).status, 200);
  assert.deepEqual(await status(), { available: true, connected: false });
  assert.ok(strava.seen.some(r => r.url === '/oauth/deauthorize'), 'Strava is told to forget the grant');
  const kept = await (await fetch(`${base}/api/data`, { headers: h('u_s1') })).json();
  assert.equal(kept.state.sessions.length, 1, 'what was imported stays');
});

test('Strava is off without the id and the secret', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-strava-off-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u_s1', name: 'S' }], creds: [], subs: [], invites: [] }));
  const env = { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' };
  delete env.STRAVA_CLIENT_ID; delete env.STRAVA_CLIENT_SECRET;
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const h = { cookie: sid('u_s1') };
  assert.deepEqual(await (await fetch(`${base}/api/strava/status`, { headers: h })).json(), { available: false, connected: false });
  assert.equal((await fetch(`${base}/api/strava/connect`, { headers: h, redirect: 'manual' })).headers.get('location'), '../../#/settings/data');
});
