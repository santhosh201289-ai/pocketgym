// groups.js: the bounds on what a coach sends, and what a coach sees of a member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, cleanPlan, cleanSchedule, memberSummary, GroupError, MAX_PLAN_BYTES } from '../groups.js';

const plan = (over = {}) => ({ pocketgym_plan: 1, unit: 'kg', week: { 1: ['r1'] }, routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 8 }] }], customEx: [], ...over });

test('names', () => {
  assert.equal(cleanName('  Morning \n batch  '), 'Morning batch');
  assert.equal(cleanName('x'.repeat(100)).length, 60);
  assert.throws(() => cleanName('   '), GroupError);
});

test('a plan is one routine with exercises, within the size limit, and no week of its own', () => {
  assert.deepEqual(cleanPlan(plan()).week, {});
  assert.throws(() => cleanPlan({ routines: [] }), e => e.status === 400);
  assert.throws(() => cleanPlan(plan({ routines: [] })), /one routine/);
  assert.throws(() => cleanPlan(plan({ routines: [plan().routines[0], plan().routines[0]] })), /one routine/);
  assert.throws(() => cleanPlan(plan({ routines: [{ id: 'r', name: 'Empty', ex: [] }] })), /exercises/);
  assert.throws(() => cleanPlan(plan({ customEx: [{ id: 'c', desc: 'x'.repeat(MAX_PLAN_BYTES) }] })), e => e.status === 413);
});

test('a schedule: real weekdays, and dates from today on', () => {
  assert.deepEqual(cleanSchedule({ weekly: [2, '4', 2, 7, -1, 1.5], dates: ['2026-10-20', '2026-10-21', '2026-10-30', 'soon', 5] }, '2026-10-21'),
    { weekly: [2, 4], dates: ['2026-10-21', '2026-10-30'] });
  assert.deepEqual(cleanSchedule({}, '2026-10-21'), { weekly: [], dates: [] });
});

test('what a coach sees of a member', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const S = {
    unit: 'lb', targetW: 150,
    customEx: [{ id: 'cx1', n: 'Sled push', bp: 'legs' }],
    routines: [{ id: 'r', name: 'Legs' }, { id: 'c', name: 'Push', fromCoach: { key: 'co:r1' } }],
    week: { 1: ['r'], 3: 'c', 9: ['x'] },
    workouts: [
      { d: '2026-05-01', name: 'Old', entries: [] },
      { d: '2026-10-20', name: 'Legs', start: 0, end: 2700000, notes: 'knee hurt', entries: [
        { id: 'cx1', sets: [{ w: 100, r: 10, done: true }, { w: 40, r: 5, done: true, phase: 'warmup' }, { w: 100, r: 8, done: false }] },
      ] },
    ],
    activity: [{ d: '2026-10-20', steps: 7000, src: 'Health Connect', t: 5 }, { d: '2026-08-01', steps: 1 }],
    sessions: [{ d: '2026-10-19', type: 'run', durS: 1800, distM: 5000, name: 'Route past my house', srcId: 'x' }],
    bodyweight: [{ d: '2026-10-01', w: 152 }, { d: '2025-01-01', w: 160 }],
    progressPhotos: [{ id: 'p' }], coach: { profile: { limitations: 'private' } },
  };
  const m = memberSummary(S, now);
  assert.equal(m.unit, 'lb');
  assert.equal(m.goalWeight, 150);
  assert.equal(m.workouts.length, 1, 'twelve weeks back');
  const [w] = m.workouts;
  assert.equal(w.minutes, 45);
  assert.equal(w.sets, 1, 'work sets done, not warm-ups or misses');
  assert.equal(w.vol, 1000);
  assert.equal(w.entries[0].name, 'Sled push');
  assert.deepEqual(w.entries[0].sets[1], { w: 40, r: 5, done: true, warmup: true });
  assert.deepEqual(m.week, { 1: ['r'], 3: ['c'] });
  assert.deepEqual(m.routines, [{ id: 'r', name: 'Legs', coach: false }, { id: 'c', name: 'Push', coach: true }]);
  assert.deepEqual(m.activity, [{ d: '2026-10-20', steps: 7000 }]);
  assert.deepEqual(m.cardio, [{ d: '2026-10-19', type: 'run', durS: 1800, distM: 5000 }]);
  assert.deepEqual(m.bodyweight, [{ d: '2026-10-01', w: 152 }]);
  assert.equal(m.perWeek.length, 8);
  assert.equal(m.perWeek.at(-1).n, 1);
  const text = JSON.stringify(m);
  for (const leak of ['knee hurt', 'Route past', 'private', 'Health Connect']) assert.ok(!text.includes(leak), leak);
  assert.equal(memberSummary(null, now).workouts.length, 0);
});
