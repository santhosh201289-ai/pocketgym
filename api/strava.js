// Strava: runs, rides, walks, swims and hikes, including everything Garmin, COROS, Polar, Suunto
// and Wahoo upload there. One Strava API application per instance (STRAVA_CLIENT_ID and
// STRAVA_CLIENT_SECRET, from strava.com/settings/api); each profile connects its own Strava
// account to it with OAuth (Settings → Data & backup → Strava), and the server keeps that
// account's tokens on the user record in db.json (0600), next to the passkeys.
//
// The server fetches, never the app: a token in the browser would be one more thing to leak, and
// the server can sync a profile whose devices are all closed. What it fetches goes into the
// profile as sessions through the same merge as every other import (ingest.js applyIngest):
// added once, never again once deleted in the app, and not when another source (Health Connect,
// a FIT file) already has the same kind of session starting within two minutes.
//
// Only the HTTP exchanges live here, with `fetch` passed in so the tests can stand in for Strava.

const DAY_S = 86400;
/** How far back the first sync of a newly connected account reaches. */
export const FIRST_DAYS = 365;
/** Re-read the last two days on every sync: an activity uploaded late, or edited, still lands. */
export const OVERLAP_S = 2 * DAY_S;
const PER_PAGE = 100;
const MAX_PAGES = 10;
const TIMEOUT_MS = 20000;
/** Strength sessions are logged in Pocket Gym itself; the same one from Strava would count twice. */
const SKIP_TYPES = new Set(['WeightTraining', 'Crossfit']);

export class StravaError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function stravaConfig(env = process.env, origin = '') {
  const clientId = String(env.STRAVA_CLIENT_ID || '').trim();
  const secret = String(env.STRAVA_CLIENT_SECRET || '').trim();
  return {
    on: !!(clientId && secret),
    clientId, secret,
    oauthBase: String(env.STRAVA_OAUTH_BASE || 'https://www.strava.com').replace(/\/$/, ''),
    apiBase: String(env.STRAVA_API_BASE || 'https://www.strava.com/api/v3').replace(/\/$/, ''),
    redirect: String(env.STRAVA_REDIRECT_URI || '').trim() || origin.replace(/\/$/, '') + '/api/strava/callback',
  };
}

export function authorizeUrl(cfg, state) {
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirect, response_type: 'code',
    approval_prompt: 'auto', scope: 'read,activity:read_all', state,
  });
  return `${cfg.oauthBase}/oauth/authorize?${q}`;
}

/** Whether the scope Strava says was granted lets activities be read. */
export const canRead = scope => String(scope || '').split(/[,\s]+/).some(s => s === 'activity:read' || s === 'activity:read_all');

async function call(fetchImpl, url, init = {}) {
  let r;
  try { r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw new StravaError(`Strava could not be reached (${e.name === 'TimeoutError' ? 'timed out' : e.message})`, 0); }
  let body = null;
  try { body = await r.json(); } catch { /* not JSON: the status says enough */ }
  if (!r.ok) {
    const why = body?.message || `HTTP ${r.status}`;
    throw new StravaError(r.status === 401 ? 'Strava refused the connection: connect it again' : r.status === 429 ? 'Strava is busy (rate limit): it will try again later' : `Strava answered: ${why}`, r.status);
  }
  return body;
}

const tokenBody = (cfg, extra) => new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.secret, ...extra });

/** The link stored on the user record, from Strava's answer to a code or a refresh. */
function linkFrom(answer, old = {}) {
  if (!answer?.access_token || !answer?.refresh_token) throw new StravaError('Strava sent no token', 502);
  const a = answer.athlete || old.athlete || {};
  return {
    ...old,
    access: answer.access_token, refresh: answer.refresh_token,
    exp: Number(answer.expires_at) || 0,
    athlete: a.id != null ? { id: a.id, name: [a.firstname, a.lastname].filter(Boolean).join(' ').trim() || old.athlete?.name || '' } : old.athlete,
  };
}

export async function exchangeCode(cfg, code, scope, fetchImpl = fetch, now = Date.now()) {
  const answer = await call(fetchImpl, `${cfg.oauthBase}/oauth/token`, {
    method: 'POST', body: tokenBody(cfg, { code, grant_type: 'authorization_code' }),
  });
  return { ...linkFrom(answer), scope: String(scope || ''), at: now };
}

/** The link with a fresh access token when the stored one runs out within ten minutes. */
export async function freshLink(cfg, link, fetchImpl = fetch, now = Date.now()) {
  if (link.exp * 1000 - now > 10 * 60000) return { link, changed: false };
  const answer = await call(fetchImpl, `${cfg.oauthBase}/oauth/token`, {
    method: 'POST', body: tokenBody(cfg, { grant_type: 'refresh_token', refresh_token: link.refresh }),
  });
  return { link: linkFrom(answer, link), changed: true };
}

/** Every activity that started after `afterS` (epoch seconds), at most a thousand. */
export async function fetchActivities(cfg, link, afterS, fetchImpl = fetch) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ after: String(Math.floor(afterS)), per_page: String(PER_PAGE), page: String(page) });
    const batch = await call(fetchImpl, `${cfg.apiBase}/athlete/activities?${q}`, { headers: { Authorization: `Bearer ${link.access}` } });
    if (!Array.isArray(batch)) throw new StravaError('Strava sent something other than a list of activities', 502);
    out.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return out;
}

/** Best effort: Strava forgets the grant. The link is dropped here whatever it answers. */
export async function deauthorize(cfg, link, fetchImpl = fetch) {
  try {
    await call(fetchImpl, `${cfg.oauthBase}/oauth/deauthorize`, { method: 'POST', body: new URLSearchParams({ access_token: link.access }) });
    return true;
  } catch { return false; }
}

/**
 * A Strava activity summary as a raw session for ingest.js cleanSession, with the time zone it
 * was recorded in (minutes east of UTC), or null for one Pocket Gym does not take.
 */
export function toSession(a) {
  if (!a || typeof a !== 'object' || a.id == null) return null;
  const type = a.sport_type || a.type;
  if (SKIP_TYPES.has(type)) return null;
  const start = Date.parse(a.start_date);
  if (!Number.isFinite(start)) return null;
  return {
    raw: {
      type, name: a.name, start,
      durS: Number(a.moving_time) || Number(a.elapsed_time) || 0,
      distM: a.distance, avgHr: a.average_heartrate, maxHr: a.max_heartrate,
      srcId: String(a.id),
    },
    tzMin: Number.isFinite(Number(a.utc_offset)) ? Math.round(Number(a.utc_offset) / 60) : 0,
  };
}

/** Where the next sync starts reading, epoch seconds. */
export function syncFrom(link, now = Date.now(), full = false) {
  const first = Math.floor(now / 1000) - FIRST_DAYS * DAY_S;
  if (full || !link.last) return first;
  return Math.max(first, link.last - OVERLAP_S);
}
