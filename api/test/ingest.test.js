// ingest.js: what an iPhone Shortcut, Health Auto Export or a script sends, read into the
// profile the way the app reads an import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num, parseWhen, parseIngest, applyIngest, cleanSession, sessionType, importId, makeToken, hashToken, looksLikeToken, IngestError, MAX_DAYS } from '../ingest.js';

const NOW = Date.parse('2026-10-21T18:00:00Z');

test('numbers as a phone writes them', () => {
  assert.equal(num(8123), 8123);
  assert.equal(num('8,123'), 8123);
  assert.equal(num('12,345.6'), 12345.6);
  assert.equal(num('5,2'), 5.2);
  assert.equal(num('410 kcal'), 410);
  assert.equal(num('8 123'), 8123);
  assert.equal(num({ qty: 7.5, units: 'hr' }), 7.5);
  for (const bad of [-1, 'abc', '', null, undefined, NaN, Infinity]) assert.equal(num(bad), undefined, String(bad));
});

test('a moment keeps the day it was recorded on, wherever the server is', () => {
  // 01:30 in India is still the 20th in UTC; the day is the 21st, as the phone wrote it.
  assert.deepEqual(parseWhen('2026-10-21 01:30:00 +0530'), { ms: Date.parse('2026-10-20T20:00:00Z'), d: '2026-10-21' });
  assert.deepEqual(parseWhen('2026-10-21T01:30:00+05:30'), { ms: Date.parse('2026-10-20T20:00:00Z'), d: '2026-10-21' });
  assert.equal(parseWhen('2026-10-21').d, '2026-10-21');
  assert.equal(parseWhen('2026-10-21T06:00:00', 330).ms, Date.parse('2026-10-21T00:30:00Z'));
  // Epoch seconds and milliseconds; the day from the offset given.
  const ms = Date.parse('2026-10-20T20:00:00Z');
  assert.deepEqual(parseWhen(ms, 330), { ms, d: '2026-10-21' });
  assert.deepEqual(parseWhen(ms / 1000, 330), { ms, d: '2026-10-21' });
  for (const bad of ['21/10/2026', 'yesterday', '', null, {}]) assert.equal(parseWhen(bad), null, String(bad));
});

test('the flat day a Shortcut sends', () => {
  const p = parseIngest({ date: '2026-10-21', steps: '8,123', distanceKm: '5,2', activeKcal: 410, restingHr: 55, sleepHours: 7.25 }, { now: NOW });
  assert.deepEqual(p.days, [{ d: '2026-10-21', steps: 8123, distM: 5200, activeKcal: 410, restHr: 55, sleepMin: 435 }]);
  assert.deepEqual(p.sessions, []);
  assert.equal(p.src, 'iPhone');
  // No date: today, where the phone is.
  const late = Date.parse('2026-10-21T20:00:00Z');   // already the 22nd in India
  assert.equal(parseIngest({ steps: 10 }, { now: late }).days[0].d, '2026-10-21');
  assert.equal(parseIngest({ steps: 10, tzOffsetMin: 330 }, { now: late }).days[0].d, '2026-10-22');
  // Miles, kilojoules, a source of its own.
  const q = parseIngest({ date: '2026-10-20', distanceMi: 1, activeKJ: 4184, source: 'Apple Watch' }, { now: NOW });
  assert.deepEqual(q.days, [{ d: '2026-10-20', distM: 1609, activeKcal: 1000 }]);
  assert.equal(q.src, 'Apple Watch');
});

test('a day still to come, or one with nothing in it, is left out', () => {
  assert.deepEqual(parseIngest({ days: [{ d: '2026-10-25', steps: 1 }, { d: '2026-10-20' }, { d: 'soon', steps: 3 }] }, { now: NOW }).days, []);
});

test('lists of days and sessions', () => {
  const p = parseIngest({
    days: [{ d: '2026-10-19', steps: 5000 }, { d: '2026-10-20', sleepMin: 400 }],
    sessions: [
      { type: 'run', start: '2026-10-20T06:30:00+05:30', end: '2026-10-20T07:00:00+05:30', distM: 5000, avgHr: 150 },
      { name: 'Pool Swim', start: '2026-10-19T07:00:00+05:30', durS: 1800, distance: { qty: 1500, units: 'm' } },
      { type: 'run', start: '2026-10-20T06:00:00Z' },                    // no length: dropped
    ],
  }, { now: NOW });
  assert.equal(p.days.length, 2);
  assert.equal(p.sessions.length, 2);
  const [run, swim] = p.sessions;
  assert.equal(run.type, 'run');
  assert.equal(run.durS, 1800);
  assert.equal(run.d, '2026-10-20');
  assert.equal(run.distM, 5000);
  assert.equal(run.avgHr, 150);
  assert.equal(run.src, 'iPhone');
  assert.equal(run.id, importId('as', `iPhone|run|${run.start}`));
  assert.equal(swim.type, 'swim');
  assert.equal(swim.distM, 1500);
  assert.equal(swim.name, 'Pool Swim');
});

test('too much in one request is refused, not cut short', () => {
  assert.throws(() => parseIngest({ days: Array.from({ length: MAX_DAYS + 1 }, () => ({ steps: 1 })) }), IngestError);
  assert.throws(() => parseIngest([1, 2]), IngestError);
  assert.throws(() => parseIngest(null), IngestError);
});

test('Health Auto Export', () => {
  const body = {
    data: {
      metrics: [
        { name: 'step_count', units: 'count', data: [{ qty: 4000, date: '2026-10-20 00:00:00 +0530' }, { qty: 1200, date: '2026-10-20 12:00:00 +0530' }, { qty: 900, date: '2026-10-21 00:00:00 +0530' }] },
        { name: 'walking_running_distance', units: 'km', data: [{ qty: 3.6, date: '2026-10-20 00:00:00 +0530' }] },
        { name: 'active_energy', units: 'kJ', data: [{ qty: 1673.6, date: '2026-10-20 00:00:00 +0530' }] },
        { name: 'resting_heart_rate', units: 'count/min', data: [{ qty: 56, date: '2026-10-20 00:00:00 +0530' }] },
        { name: 'sleep_analysis', units: 'hr', data: [{ totalSleep: 7.5, sleepEnd: '2026-10-21 06:40:00 +0530', date: '2026-10-21 00:00:00 +0530' }] },
        { name: 'vo2_max', units: 'ml/(kg·min)', data: [{ qty: 44, date: '2026-10-20 00:00:00 +0530' }] },
      ],
      workouts: [{
        id: 'ABC-123', name: 'Outdoor Run', start: '2026-10-20 06:30:00 +0530', end: '2026-10-20 07:05:00 +0530', duration: 2100,
        distance: { qty: 6.1, units: 'km' }, activeEnergyBurned: { qty: 420, units: 'kcal' },
        heartRate: { avg: { qty: 152, units: 'bpm' }, max: { qty: 171, units: 'bpm' } },
      }],
    },
  };
  const p = parseIngest(body, { now: NOW });
  assert.equal(p.src, 'Apple Health');
  assert.deepEqual(p.days, [
    { d: '2026-10-20', steps: 5200, distM: 3600, activeKcal: 400, restHr: 56 },
    { d: '2026-10-21', steps: 900, sleepMin: 450 },
  ]);
  const [w] = p.sessions;
  assert.equal(w.type, 'run');
  assert.equal(w.durS, 2100);
  assert.equal(w.distM, 6100);
  assert.equal(w.kcal, 420);
  assert.equal(w.avgHr, 152);
  assert.equal(w.maxHr, 171);
  assert.equal(w.srcId, 'ABC-123');
  assert.equal(w.id, importId('as', 'Apple Health|ABC-123'));
});

test('kinds of session by name', () => {
  const kinds = { 'Outdoor Run': 'run', 'Treadmill jog': 'run', 'Indoor Walk': 'walk', Hiking: 'hike', 'Outdoor Cycle': 'ride', 'Spin class': 'ride', 'Open Water Swim': 'swim', Yoga: 'other', ride: 'ride' };
  for (const [name, kind] of Object.entries(kinds)) assert.equal(sessionType(name), kind, name);
});

test('merged as the app merges an import', () => {
  const S = {
    activity: [{ d: '2026-10-20', steps: 3000, sleepMin: 420, src: 'Health Connect', t: 1 }],
    sessions: [{ id: 'as1', type: 'run', start: Date.parse('2026-10-19T01:00:00Z'), durS: 1800, _ts: 1 }],
    deleted: { sessions: { [importId('as', 'iPhone|ride|' + Date.parse('2026-10-18T01:00:00Z'))]: 5 } },
  };
  const parsed = parseIngest({
    days: [{ d: '2026-10-20', steps: 6500 }, { d: '2026-10-21', steps: 900 }],
    sessions: [
      { type: 'run', start: '2026-10-19T01:01:00Z', durS: 1700 },         // the same run, a minute on
      { type: 'ride', start: '2026-10-18T01:00:00Z', durS: 3600 },        // deleted on purpose
      { type: 'walk', start: '2026-10-21T01:00:00Z', durS: 900 },
    ],
  }, { now: NOW });
  const got = applyIngest(S, parsed, NOW);
  assert.deepEqual(got, { days: 2, sessions: 1 });
  // Steps replaced, the sleep the other source sent kept.
  assert.deepEqual(S.activity, [
    { d: '2026-10-20', steps: 6500, sleepMin: 420, src: 'iPhone', t: NOW },
    { d: '2026-10-21', steps: 900, src: 'iPhone', t: NOW },
  ]);
  assert.deepEqual(S.sessions.map(s => s.type), ['walk', 'run']);
  assert.equal(S.sessions[0]._ts, NOW);
  // The same numbers again change nothing and stamp nothing.
  assert.deepEqual(applyIngest(S, parsed, NOW + 1000), { days: 0, sessions: 0 });
  assert.equal(S.activity[0].t, NOW);
});

test('a session without a start or a length is no session', () => {
  assert.equal(cleanSession({ type: 'run', durS: 60 }), null);
  assert.equal(cleanSession({ type: 'run', start: '2026-10-20T06:00:00Z', end: '2026-10-20T05:00:00Z' }), null);
  assert.equal(cleanSession('run'), null);
});

test('tokens', () => {
  const t = makeToken();
  assert.ok(looksLikeToken(t));
  assert.notEqual(makeToken(), t);
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.equal(looksLikeToken('eyJhbGciOi.session'), false);
  assert.equal(looksLikeToken('pgi_' + 'x'.repeat(200)), false);
});
