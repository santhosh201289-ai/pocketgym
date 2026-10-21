// Activity sent in from outside the app: an iPhone Shortcut, Health Auto Export, a script. The
// iPhone has no Health Connect, and Apple Health can only be read by a native app with its own
// entitlement, so the phone sends its own numbers instead: POST /api/ingest/activity with the
// profile's ingest token (Settings → Data & backup → Send activity from iPhone).
//
// The token is its own credential, never a session: it can add steps, sleep, heart rate and
// cardio sessions to one profile and do nothing else — not read the profile, not change a workout.
// Only its SHA-256 is stored (user.ingest.hash), so db.json never holds one that works.
//
// What lands in the document is exactly what the app would have written itself (lib/activity.js
// mergeDays/addSessions, hand-copied like sync-stamps.js): a day merged field by field and stamped
// `t`, a session added once with its `_ts`. Every device then merges it like any other change.
//
// Accepted bodies, all JSON:
//   - one day, flat — what a Shortcut builds most easily:
//       { "date": "2026-10-21", "steps": 8123, "distanceKm": 5.2, "activeKcal": 410,
//         "restingHr": 55, "sleepHours": 7.2 }
//   - lists: { "days": [{ d, steps, distM, activeKcal, restHr, sleepMin }, …],
//              "sessions": [{ type, start, end | durS, distM, kcal, avgHr, maxHr, name, id }, …] }
//   - Health Auto Export's REST format: { "data": { "metrics": [...], "workouts": [...] } }
// Numbers may come as strings ("8,123", "5,2", "410 kcal"), dates as "YYYY-MM-DD", ISO 8601 or
// Health Auto Export's "2026-10-21 06:30:00 +0530". A day is the calendar date as written on the
// phone, never converted to the server's time zone.
import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'pgi_';
export const makeToken = () => TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
export const looksLikeToken = t => typeof t === 'string' && t.startsWith(TOKEN_PREFIX) && t.length <= 80;

/** Most days and sessions one request may carry: a year and a bit, and a busy year of cardio. */
export const MAX_DAYS = 400;
export const MAX_SESSIONS = 500;

export class IngestError extends Error {}

const SESSION_TYPES = ['run', 'walk', 'ride', 'swim', 'hike', 'other'];
const DAY_FIELDS = ['steps', 'distM', 'activeKcal', 'restHr', 'sleepMin'];
const list = v => (Array.isArray(v) ? v : []);
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A non-negative number from a number or a phone-formatted string, else undefined. */
export function num(v) {
  if (isMap(v)) v = v.qty ?? v.value ?? v.avg;
  if (typeof v === 'string') {
    let s = v.trim().replace(/[\s  ]/g, '');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?/.test(s)) s = s.replace(/,/g, '');   // 8,123 or 12,345.6
    else if (/^\d+,\d+/.test(s)) s = s.replace(',', '.');               // 5,2 (a comma locale)
    v = parseFloat(s);
  }
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

// "2026-10-21", "2026-10-21T06:30:00+05:30", "2026-10-21 06:30:00 +0530", "…Z".
const WHEN_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const offsetText = min => {
  const a = Math.abs(min);
  return (min < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
};
const dayAt = (ms, offMin) => new Date(ms + offMin * 60000).toISOString().slice(0, 10);

/**
 * A moment: { ms, d } — epoch milliseconds, and the calendar day it fell on where it was
 * recorded. `tzMin` (minutes east of UTC) places a time written without an offset, and the day
 * of an epoch number; without it, UTC.
 */
export function parseWhen(v, tzMin = 0) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v > 1e11 ? v : v * 1000;                                  // seconds or milliseconds
    return { ms, d: dayAt(ms, tzMin) };
  }
  if (typeof v !== 'string') return null;
  const m = WHEN_RE.exec(v.trim());
  if (!m) return null;
  const [, d, time, off] = m;
  const zone = off ? (off === 'Z' ? 'Z' : off.length === 5 ? off.slice(0, 3) + ':' + off.slice(3) : off) : offsetText(tzMin);
  const ms = Date.parse(`${d}T${time || '00:00'}${zone}`);
  if (!Number.isFinite(ms)) return null;
  return { ms, d };
}

const metres = (qty, units) => {
  const v = num(qty);
  if (v === undefined) return undefined;
  const u = String(units || 'm').toLowerCase();
  if (u === 'km') return v * 1000;
  if (u === 'mi' || u === 'mile' || u === 'miles') return v * 1609.344;
  if (u === 'yd' || u === 'yard' || u === 'yards') return v * 0.9144;
  return v;
};
const kcalOf = (qty, units) => {
  const v = num(qty);
  if (v === undefined) return undefined;
  return String(units || 'kcal').toLowerCase() === 'kj' ? v / 4.184 : v;
};
const unitsOf = v => (isMap(v) ? v.units : undefined);

/** One day's fields from the names a person or a Shortcut would use. */
function dayFields(x) {
  const out = {};
  const set = (f, v) => { if (v !== undefined) out[f] = v; };
  set('steps', num(x.steps ?? x.stepCount ?? x.step_count));
  set('distM', num(x.distM) ?? metres(x.distanceKm, 'km') ?? metres(x.distanceMi, 'mi') ??
    (x.distance != null ? metres(x.distance, unitsOf(x.distance) || x.distanceUnit || 'km') : undefined));
  set('activeKcal', num(x.activeKcal) ?? kcalOf(x.activeEnergy ?? x.active_energy, unitsOf(x.activeEnergy ?? x.active_energy)) ?? kcalOf(x.activeKJ, 'kJ'));
  set('restHr', num(x.restHr ?? x.restingHr ?? x.restingHeartRate ?? x.resting_heart_rate));
  set('sleepMin', num(x.sleepMin) ?? (num(x.sleepHours ?? x.sleep) !== undefined ? num(x.sleepHours ?? x.sleep) * 60 : undefined));
  return out;
}

/** "Outdoor Run", "Cycling", "pool swim" → the app's kinds. */
export function sessionType(name) {
  const s = String(name || '').toLowerCase();
  if (SESSION_TYPES.includes(s)) return s;
  if (/run|jog/.test(s)) return 'run';
  if (/hik/.test(s)) return 'hike';
  if (/walk/.test(s)) return 'walk';
  if (/cycl|bik|ride|spin/.test(s)) return 'ride';
  if (/swim/.test(s)) return 'swim';
  return 'other';
}

// lib/import-csv.js importId, verbatim: the same input names the same session on both sides.
export function importId(prefix, text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return prefix + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A session in the stored shape (lib/activity.js cleanSession), or null without a start and a length. */
export function cleanSession(x, src, tzMin = 0) {
  if (!isMap(x)) return null;
  const st = parseWhen(x.start ?? x.startDate, tzMin);
  if (!st) return null;
  const en = parseWhen(x.end ?? x.endDate, tzMin);
  let durS = num(x.durS) ?? num(x.duration);
  if (durS === undefined && en && en.ms > st.ms) durS = (en.ms - st.ms) / 1000;
  if (!durS) return null;
  const type = sessionType(x.type ?? x.name ?? x.workoutActivityType);
  const out = { type, start: st.ms, end: st.ms + Math.round(durS) * 1000, durS: Math.round(durS), d: st.d };
  const distM = num(x.distM) ?? (x.distance != null ? metres(x.distance, unitsOf(x.distance) || x.distanceUnit || 'km') : metres(x.distanceKm, 'km'));
  const kcal = num(x.kcal) ?? kcalOf(x.activeEnergyBurned ?? x.activeEnergy, unitsOf(x.activeEnergyBurned ?? x.activeEnergy));
  const hr = isMap(x.heartRate) ? x.heartRate : {};
  const fields = {
    distM, kcal,
    avgHr: num(x.avgHr) ?? num(x.avgHeartRate) ?? num(hr.avg),
    maxHr: num(x.maxHr) ?? num(x.maxHeartRate) ?? num(hr.max),
    laps: num(x.laps), poolM: num(x.poolM),
  };
  for (const [f, v] of Object.entries(fields)) if (v !== undefined && v > 0) out[f] = Math.round(v);
  if (x.name != null && String(x.name).trim()) out.name = String(x.name).trim().slice(0, 80);
  out.src = String(x.src || src || 'manual').slice(0, 40);
  const srcId = x.srcId ?? x.id;
  if (srcId != null && srcId !== '') out.srcId = String(srcId).slice(0, 120);
  out.id = out.srcId ? importId('as', `${out.src}|${out.srcId}`) : importId('as', `${out.src}|${out.type}|${out.start}`);
  return out;
}

// Health Auto Export: every metric is a list of points, one per day when its export is set to
// aggregate by day, finer otherwise. Points of the same day add up (steps, distance, energy) or
// the last one stands (resting heart rate); sleep counts the time asleep, on the day it ended.
function fromAutoExport(data, tzMin) {
  const days = new Map();
  const at = d => days.get(d) || days.set(d, { d }).get(d);
  const add = (d, f, v) => { if (v === undefined) return; const e = at(d); e[f] = (e[f] || 0) + v; };
  for (const m of list(data.metrics)) {
    if (!isMap(m)) continue;
    const name = String(m.name || '').toLowerCase();
    for (const p of list(m.data)) {
      if (!isMap(p)) continue;
      const when = parseWhen(p.sleepEnd ?? p.endDate ?? p.date, tzMin) || parseWhen(p.date, tzMin);
      if (!when) continue;
      if (name === 'step_count') add(when.d, 'steps', num(p.qty));
      else if (name === 'walking_running_distance') add(when.d, 'distM', metres(p.qty, m.units));
      else if (name === 'active_energy') add(when.d, 'activeKcal', kcalOf(p.qty, m.units));
      else if (name === 'resting_heart_rate') { const v = num(p.qty ?? p.Avg ?? p.avg); if (v !== undefined) at(when.d).restHr = v; }
      else if (name === 'sleep_analysis') {
        const hrs = num(p.totalSleep) ?? num(p.asleep) ??
          (/awake|in ?bed/i.test(String(p.value || '')) ? undefined : num(p.qty));
        if (hrs !== undefined) add(when.d, 'sleepMin', hrs * 60);
      }
    }
  }
  return { days: [...days.values()], sessions: list(data.workouts) };
}

/**
 * The days and sessions a request carries, cleaned: { days: [{ d, …fields }], sessions: [...],
 * src }. Throws IngestError for a body that is none of the accepted shapes.
 */
export function parseIngest(body, { now = Date.now() } = {}) {
  if (!isMap(body)) throw new IngestError('expected a JSON object');
  const tzMin = Number.isFinite(Number(body.tzOffsetMin)) && Math.abs(Number(body.tzOffsetMin)) <= 14 * 60 ? Math.round(Number(body.tzOffsetMin)) : 0;
  const auto = isMap(body.data) && (Array.isArray(body.data.metrics) || Array.isArray(body.data.workouts));
  const src = String(body.source || body.src || (auto ? 'Apple Health' : 'iPhone')).trim().slice(0, 40) || 'iPhone';
  let rawDays, rawSessions;
  if (auto) ({ days: rawDays, sessions: rawSessions } = fromAutoExport(body.data, tzMin));
  else {
    rawDays = Array.isArray(body.days) ? body.days : [];
    rawSessions = Array.isArray(body.sessions) ? body.sessions : Array.isArray(body.workouts) ? body.workouts : [];
    // The flat form: the body is the day.
    if (!Array.isArray(body.days) && Object.keys(dayFields(body)).length) rawDays = [{ ...body, d: body.date ?? body.d }];
  }
  if (rawDays.length > MAX_DAYS) throw new IngestError(`at most ${MAX_DAYS} days per request`);
  if (rawSessions.length > MAX_SESSIONS) throw new IngestError(`at most ${MAX_SESSIONS} sessions per request`);
  const today = dayAt(now, tzMin);
  const days = [];
  for (const x of rawDays) {
    if (!isMap(x)) continue;
    const raw = x.d ?? x.date;
    const d = raw == null || raw === '' ? today : parseWhen(raw, tzMin)?.d;
    if (!d || !DAY_RE.test(d) || d > today) continue;                   // a day still to come is a typo
    const fields = dayFields(x);
    for (const f of Object.keys(fields)) fields[f] = roundField(f, fields[f]);
    if (Object.keys(fields).length) days.push({ d, ...fields });
  }
  const sessions = rawSessions.map(x => cleanSession(x, src, tzMin)).filter(s => s && s.start <= now + 86400000);
  return { days, sessions, src };
}

// The same session from two sources: the same kind, starting within two minutes (lib/activity.js).
const roundField = (f, v) => (f === 'restHr' ? Math.round(v * 10) / 10 : Math.round(v));

const SAME_START_MS = 2 * 60000;
const sameSession = (a, b) => a.id === b.id || (a.type === b.type && Math.abs(a.start - b.start) <= SAME_START_MS);

/**
 * `parsed` merged into the document `S`, in place, as the app merges an import: a day field by
 * field, stamped `t = now` when anything in it changed; a session added once, never one the
 * profile has or one deleted on record. Returns how many days changed and sessions were added.
 */
export function applyIngest(S, { days, sessions, src }, now = Date.now()) {
  const byDay = new Map(list(S.activity).filter(e => e && e.d).map(e => [e.d, e]));
  let changedDays = 0;
  for (const day of list(days)) {
    const old = byDay.get(day.d);
    const next = { ...(old || { d: day.d }) };
    let moved = false;
    for (const f of DAY_FIELDS) {
      if (day[f] === undefined) continue;
      const r = roundField(f, day[f]);
      if (next[f] !== r) { next[f] = r; moved = true; }
    }
    if (!moved) continue;
    next.src = src || next.src || 'manual';
    next.t = now;
    byDay.set(day.d, next);
    changedDays++;
  }
  if (changedDays) S.activity = [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1));

  const gone = isMap(S.deleted?.sessions) ? S.deleted.sessions : {};
  const out = list(S.sessions).slice();
  let added = 0;
  for (const s of list(sessions)) {
    if (Number(gone[s.id]) > 0) continue;                               // removed on purpose
    if (out.some(x => x && sameSession(x, s))) continue;
    out.push({ ...s, _ts: now });
    added++;
  }
  if (added) S.sessions = out.sort((a, b) => (b.start || 0) - (a.start || 0));
  return { days: changedDays, sessions: added };
}
