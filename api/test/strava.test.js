// strava.js: the OAuth and activity exchanges with Strava, against a stand-in fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stravaConfig, authorizeUrl, canRead, exchangeCode, freshLink, fetchActivities, toSession, syncFrom, deauthorize, StravaError, FIRST_DAYS, OVERLAP_S } from '../strava.js';
import { cleanSession } from '../ingest.js';

const cfg = stravaConfig({ STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 's3cret' }, 'https://gym.example');
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('configured only with both the id and the secret', () => {
  assert.equal(cfg.on, true);
  assert.equal(cfg.redirect, 'https://gym.example/api/strava/callback');
  assert.equal(stravaConfig({ STRAVA_CLIENT_ID: '123' }).on, false);
  assert.equal(stravaConfig({}).on, false);
  assert.equal(stravaConfig({ STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: '2', STRAVA_REDIRECT_URI: 'https://x/gym/api/strava/callback' }).redirect, 'https://x/gym/api/strava/callback');
});

test('the authorize link asks to read activities and carries the state', () => {
  const u = new URL(authorizeUrl(cfg, 'st4te'));
  assert.equal(u.origin + u.pathname, 'https://www.strava.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), '123');
  assert.equal(u.searchParams.get('state'), 'st4te');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://gym.example/api/strava/callback');
  assert.ok(canRead(u.searchParams.get('scope')));
  assert.ok(canRead('read,activity:read'));
  assert.equal(canRead('read'), false);
  assert.equal(canRead(null), false);
});

test('a code becomes a link; a link near its end is refreshed', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push([url, Object.fromEntries(init.body)]);
    return reply(200, { access_token: 'a1', refresh_token: 'r1', expires_at: 2000000000, athlete: { id: 9, firstname: 'Asha', lastname: 'K' } });
  };
  const link = await exchangeCode(cfg, 'c0de', 'read,activity:read_all', fetchImpl, 5);
  assert.deepEqual(link, { access: 'a1', refresh: 'r1', exp: 2000000000, athlete: { id: 9, name: 'Asha K' }, scope: 'read,activity:read_all', at: 5 });
  assert.deepEqual(sent[0], ['https://www.strava.com/oauth/token', { client_id: '123', client_secret: 's3cret', code: 'c0de', grant_type: 'authorization_code' }]);

  assert.equal((await freshLink(cfg, link, fetchImpl, 1000)).changed, false);
  const old = { ...link, exp: 100, last: 7 };
  const r = await freshLink(cfg, old, async () => reply(200, { access_token: 'a2', refresh_token: 'r2', expires_at: 3000000000 }), 100000);
  assert.equal(r.changed, true);
  assert.equal(r.link.access, 'a2');
  assert.equal(r.link.refresh, 'r2');
  assert.equal(r.link.last, 7, 'the rest of the link is kept');
  assert.deepEqual(r.link.athlete, { id: 9, name: 'Asha K' });
});

test('refusals come back as StravaError with the status', async () => {
  await assert.rejects(exchangeCode(cfg, 'x', '', async () => reply(400, { message: 'Bad Request' })), e => e instanceof StravaError && e.status === 400);
  await assert.rejects(fetchActivities(cfg, { access: 'a' }, 0, async () => reply(401, {})), e => e.status === 401 && /connect it again/.test(e.message));
  await assert.rejects(fetchActivities(cfg, { access: 'a' }, 0, async () => { throw new TypeError('fetch failed'); }), e => e.status === 0);
  assert.equal(await deauthorize(cfg, { access: 'a' }, async () => reply(500, {})), false);
});

test('activities are read page by page', async () => {
  const urls = [];
  const all = Array.from({ length: 130 }, (_, i) => ({ id: i }));
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const page = +new URL(url).searchParams.get('page');
    return reply(200, all.slice((page - 1) * 100, page * 100));
  };
  const got = await fetchActivities(cfg, { access: 'tok' }, 1700000000.7, fetchImpl);
  assert.equal(got.length, 130);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).searchParams.get('after'), '1700000000');
});

test('a Strava activity as a session, on the day it was recorded', () => {
  const run = {
    id: 12345678901, name: 'Morning Run', sport_type: 'TrailRun', type: 'Run',
    start_date: '2026-10-20T00:45:00Z', start_date_local: '2026-10-20T06:15:00Z', utc_offset: 19800,
    moving_time: 1800, elapsed_time: 1900, distance: 5012.3, average_heartrate: 148.6, max_heartrate: 171,
  };
  const x = toSession(run);
  assert.equal(x.tzMin, 330);
  const s = cleanSession(x.raw, 'Strava', x.tzMin);
  assert.equal(s.type, 'run');
  assert.equal(s.d, '2026-10-20');
  assert.equal(s.durS, 1800);
  assert.equal(s.distM, 5012);
  assert.equal(s.avgHr, 149);
  assert.equal(s.srcId, '12345678901');
  assert.equal(s.src, 'Strava');
  // An early run east of UTC is still the day it was run on.
  const early = cleanSession(toSession({ ...run, start_date: '2026-10-19T23:00:00Z' }).raw, 'Strava', 330);
  assert.equal(early.d, '2026-10-20');

  for (const [t, kind] of [['Ride', 'ride'], ['VirtualRide', 'ride'], ['MountainBikeRide', 'ride'], ['EBikeRide', 'ride'], ['Swim', 'swim'], ['Walk', 'walk'], ['Hike', 'hike'], ['Yoga', 'other']]) {
    assert.equal(cleanSession(toSession({ ...run, sport_type: t }).raw, 'Strava').type, kind, t);
  }
  assert.equal(toSession({ ...run, sport_type: 'WeightTraining' }), null, 'strength is logged in Pocket Gym');
  assert.equal(toSession({ ...run, start_date: 'soon' }), null);
  assert.equal(toSession(null), null);
});

test('where a sync starts reading', () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  const first = now / 1000 - FIRST_DAYS * 86400;
  assert.equal(syncFrom({}, now), first);
  assert.equal(syncFrom({ last: now / 1000 - 3600 }, now), now / 1000 - 3600 - OVERLAP_S);
  assert.equal(syncFrom({ last: now / 1000 - 3600 }, now, true), first);
  assert.equal(syncFrom({ last: 5 }, now), first, 'never further back than the first sync');
});
