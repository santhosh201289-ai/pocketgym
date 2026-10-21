// The activity category: steps, sleep, resting heart rate and cardio reach the Coach only under a
// consent that names them (version 3), and only as the summary built here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData, sampleState } from './helpers.mjs';

tempData();
const payload = await import('../coach/core/payload.js');

const iso = d => d.toISOString().slice(0, 10);
const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

function withActivity(version) {
  const S = sampleState();
  S.coach = { ...(S.coach || {}), consent: { agreedAt: '2026-10-01T00:00:00Z', version } };
  S.activity = Array.from({ length: 20 }, (_, i) => ({ d: ago(i), steps: 8000 + i, sleepMin: 420, restHr: 55, src: 'Health Connect', t: 1 }));
  S.sessions = [
    { id: 'as1', type: 'run', start: 1, durS: 1800, distM: 5012, avgHr: 150.4, d: ago(3), src: 'Strava', srcId: '99', name: 'Secret route by my house', _ts: 1 },
    { id: 'as2', type: 'kayak', durS: 600, d: ago(2), _ts: 1 },
  ];
  return S;
}

test('none of it under a consent from before the category existed', () => {
  for (const kind of ['review', 'create', 'debrief']) {
    const p = payload.build(withActivity(2), { handle: 'h'.repeat(16), kind });
    assert.equal(p.activity, undefined, kind);
  }
});

test('a summary under consent version 3: weekly, the last two weeks daily, the sessions', () => {
  const p = payload.build(withActivity(3), { handle: 'h'.repeat(16), kind: 'review' });
  assert.ok(p.activity, 'present');
  assert.equal(p.activity.daily.length, payload.ACTIVITY_DAILY);
  assert.deepEqual(Object.keys(p.activity.daily[0]).sort(), ['d', 'restHr', 'sleepH', 'steps']);
  assert.equal(p.activity.daily[0].sleepH, 7);
  assert.ok(p.activity.weekly.length >= 3);
  assert.deepEqual(p.activity.sessions, [
    { d: ago(3), type: 'run', min: 30, km: 5, avgHr: 150 },
    { d: ago(2), type: 'other', min: 10 },
  ]);
  // The allowlist: no names, sources, ids or stamps.
  const text = JSON.stringify(p.activity);
  for (const leak of ['Secret route', 'Strava', 'Health Connect', 'as1', 'srcId', '_ts']) assert.ok(!text.includes(leak), leak);
});

test('a debrief reads the week before the session, a new plan the last four weeks', () => {
  const S = withActivity(3);
  const debrief = payload.build(S, { handle: 'h'.repeat(16), kind: 'debrief' });
  if (debrief.session) assert.ok(debrief.activity.daily.every(e => e.d <= debrief.session.d));
  const create = payload.build(S, { handle: 'h'.repeat(16), kind: 'create' });
  assert.ok(create.activity.daily.every(e => e.d >= ago(28)));
});

test('absent, not empty, when there is nothing to tell', () => {
  const S = withActivity(3);
  S.activity = []; S.sessions = [];
  assert.equal(payload.build(S, { handle: 'h'.repeat(16), kind: 'review' }).activity, undefined);
});
