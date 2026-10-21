// Groups end to end: only a coach makes one, people are added by name and see nothing until they
// accept, the coach reads an active member only, assignments wait in the member's inbox, and
// either side can end it.
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
const SECRET = 'test-secret-groups';
const sid = uid => { const p = `${uid}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };
const PLAN = { pocketgym_plan: 1, unit: 'kg', week: { 2: ['r1'] }, routines: [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8 }] }], customEx: [] };

test('groups: coach, members, assignments', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-groups-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'adm', name: 'Admin', admin: true }, { id: 'co', name: 'Coach Ravi' }, { id: 'm1', name: 'Asha' }, { id: 'm2', name: 'Arjun' }, { id: 'x', name: 'Outsider' }],
    creds: [], subs: [], invites: [],
  }));
  fs.writeFileSync(path.join(dataDir, 'state-m1.json'), JSON.stringify({
    _rev: 1, unit: 'kg', routines: [{ id: 'r', name: 'Legs' }], week: { 1: ['r'] },
    workouts: [{ id: 'w1', d: new Date().toISOString().slice(0, 10), name: 'Legs', start: 0, end: 3600000, entries: [{ id: '0043', sets: [{ w: 100, r: 5, done: true }] }], notes: 'private note' }],
    bodyweight: [{ d: new Date().toISOString().slice(0, 10), w: 70 }],
    activity: [{ d: new Date().toISOString().slice(0, 10), steps: 9000 }],
    progressPhotos: [{ id: 'secret-photo' }],
  }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const call = async (uid, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { cookie: sid(uid), origin: 'http://localhost:8080', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  // Not a coach yet.
  assert.equal((await call('co', 'POST', '/api/groups', { name: 'Morning batch' })).status, 403);
  assert.equal((await call('co', 'GET', '/api/groups/people?q=as')).status, 403);
  // The admin makes them one; /api/me says so.
  assert.equal((await call('co', 'POST', '/api/admin/user/coach', { id: 'co', coach: true })).status, 403, 'only an admin');
  assert.equal((await call('adm', 'POST', '/api/admin/user/coach', { id: 'co', coach: true })).body.coach, true);
  assert.equal((await call('co', 'GET', '/api/me')).body.user.coach, true);

  const made = await call('co', 'POST', '/api/groups', { name: '  Morning   batch ' });
  assert.equal(made.status, 200);
  const g = made.body.coaching[0];
  assert.equal(g.name, 'Morning batch');

  const found = (await call('co', 'GET', `/api/groups/people?q=a&group=${g.id}`)).body.people;
  assert.deepEqual(found, [], 'two letters at least');
  assert.deepEqual((await call('co', 'GET', `/api/groups/people?q=as&group=${g.id}`)).body.people, [{ uid: 'm1', name: 'Asha', status: null }]);

  await call('co', 'POST', '/api/groups/members/add', { group: g.id, uid: 'm1' });
  await call('co', 'POST', '/api/groups/members/add', { group: g.id, uid: 'm2' });
  // Someone else's group is not there to add to.
  assert.equal((await call('x', 'POST', '/api/groups/members/add', { group: g.id, uid: 'm1' })).status, 404);

  // Invited, not yet active: the coach sees nothing of them and cannot send them anything.
  assert.equal((await call('co', 'GET', `/api/groups/member?group=${g.id}&uid=m1`)).status, 404);
  assert.equal((await call('co', 'POST', '/api/groups/assign', { group: g.id, to: 'all', plan: PLAN, weekly: [2] })).status, 400);
  const inv = (await call('m1', 'GET', '/api/groups/inbox')).body;
  assert.deepEqual(inv.invites.map(i => [i.name, i.coach]), [['Morning batch', 'Coach Ravi']]);

  // Asha accepts; Arjun turns it down.
  await call('m1', 'POST', '/api/groups/respond', { group: g.id, accept: true });
  await call('m2', 'POST', '/api/groups/respond', { group: g.id, accept: false });
  const view = (await call('co', 'GET', '/api/groups')).body.coaching[0];
  assert.deepEqual(view.members.map(m => [m.name, m.status]), [['Asha', 'active']]);

  // The coach reads her training, activity and weight, and nothing else.
  const m = await call('co', 'GET', `/api/groups/member?group=${g.id}&uid=m1`);
  assert.equal(m.status, 200);
  assert.equal(m.body.workouts[0].entries[0].sets[0].w, 100);
  assert.equal(m.body.workouts[0].sets, 1);
  assert.equal(m.body.activity[0].steps, 9000);
  assert.equal(m.body.bodyweight[0].w, 70);
  assert.deepEqual(m.body.week, { 1: ['r'] });
  const text = JSON.stringify(m.body);
  assert.ok(!text.includes('private note') && !text.includes('secret-photo'), 'no notes, no photos');
  assert.equal((await call('x', 'GET', `/api/groups/member?group=${g.id}&uid=m1`)).status, 404);

  // An assignment waits in her inbox; the server does not touch her plan.
  const bad = await call('co', 'POST', '/api/groups/assign', { group: g.id, to: 'all', plan: { ...PLAN, routines: [] }, weekly: [2] });
  assert.equal(bad.status, 400);
  const sent = await call('co', 'POST', '/api/groups/assign', { group: g.id, to: ['m1', 'm2', 'x'], plan: PLAN, weekly: [2, 9], dates: ['2000-01-01', '2999-01-01'], note: 'Start light' });
  assert.equal(sent.status, 200);
  const box = (await call('m1', 'GET', '/api/groups/inbox')).body.assignments;
  assert.equal(box.length, 1, 'only to the active member');
  assert.deepEqual([box[0].weekly, box[0].dates, box[0].note, box[0].coach], [[2], ['2999-01-01'], 'Start light', 'Coach Ravi']);
  assert.deepEqual(box[0].plan.week, {}, 'the schedule travels beside the plan');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'state-m1.json'), 'utf8')).week, { 1: ['r'] });
  assert.equal((await call('m2', 'POST', '/api/groups/inbox/answer', { id: box[0].id, accept: true })).status, 404, 'not hers to answer');
  await call('m1', 'POST', '/api/groups/inbox/answer', { id: box[0].id, accept: true });
  assert.equal((await call('m1', 'GET', '/api/groups/inbox')).body.assignments.length, 0);
  assert.equal((await call('co', 'GET', `/api/groups/sent?group=${g.id}`)).body.sent[0].status, 'accepted');

  // She leaves: the coach can no longer read her.
  await call('m1', 'POST', '/api/groups/respond', { group: g.id, accept: false });
  assert.equal((await call('co', 'GET', `/api/groups/member?group=${g.id}&uid=m1`)).status, 404);
  assert.deepEqual((await call('m1', 'GET', '/api/groups')).body.memberOf, []);

  // Deleting the coach's account takes the group with it.
  await call('adm', 'POST', '/api/admin/user/delete', { id: 'co' });
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual([db.groups, db.assignments], [[], []]);
});
