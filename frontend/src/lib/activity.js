// Activity from phones, bands and watches: daily totals (`S.activity`) and cardio sessions
// (`S.sessions`). Both are synced and merged like the rest of the profile (lib/sync-merge.js):
// a day is one record kept by its `t`, like a weigh-in; a session is an entry with an id and a
// `_ts`, like a gym card.
//
//   S.activity = [{ d: 'YYYY-MM-DD', steps?, distM?, activeKcal?, restHr?, sleepMin?, src, t }]
//   S.sessions = [{ id, type, start, end, durS, distM?, kcal?, avgHr?, maxHr?, laps?, poolM?,
//                   name?, src, srcId?, d, _ts }]
//
// Sessions are kept apart from strength `workouts` on purpose: progression, volume, PRs and the
// Coach's training window read workouts only, and a 10 km run must not count as a set of squats.
// Distances are stored in metres and shown in km or miles, following the speed unit
// (lib/speed.js), so switching the unit rewrites nothing.
import { importId } from './import-csv.js'
import { speedUnitOf, KMH_PER_MPH } from './speed.js'
import { isoOf } from './format.js'

/** The kinds of session, in the order pickers list them. */
export const SESSION_TYPES = ['run', 'walk', 'ride', 'swim', 'hike', 'other']
const TYPE_LABEL = { run: 'Run', walk: 'Walk', ride: 'Ride', swim: 'Swim', hike: 'Hike', other: 'Other' }
export const sessionLabel = type => TYPE_LABEL[type] || TYPE_LABEL.other
export const normType = t => (SESSION_TYPES.includes(t) ? t : 'other')

/** The fields a day record can carry, each a non-negative number. */
export const DAY_FIELDS = ['steps', 'distM', 'activeKcal', 'restHr', 'sleepMin']

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? undefined : Number(v))
const list = v => (Array.isArray(v) ? v : [])

/**
 * `days` merged into `current`, field by field: a field the incoming day carries replaces this
 * one's, the others stay (steps from the band and sleep from the phone both survive). A day that
 * changed gets `t = now`, which is what the merge across devices keeps. Returns a new sorted list,
 * and how many days were added or changed.
 */
export function mergeDays(current, days, src, now = Date.now()) {
  const byDay = new Map(list(current).filter(e => e && e.d).map(e => [e.d, e]))
  let changed = 0
  for (const day of list(days)) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.d || '')) continue
    const old = byDay.get(day.d)
    const next = { ...(old || { d: day.d }) }
    let moved = false
    for (const f of DAY_FIELDS) {
      const v = num(day[f])
      if (v === undefined) continue
      const r = f === 'steps' || f === 'activeKcal' || f === 'sleepMin' || f === 'distM' ? Math.round(v) : Math.round(v * 10) / 10
      if (next[f] !== r) { next[f] = r; moved = true }
    }
    if (!moved) continue
    next.src = day.src || src || next.src || 'manual'
    next.t = now
    byDay.set(day.d, next)
    changed++
  }
  return { activity: [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1)), changed }
}

/** A session cleaned to the stored shape, or null when it lacks a start or a duration. */
export function cleanSession(x, src) {
  const start = Number(x?.start)
  const durS = num(x?.durS) ?? (Number(x?.end) > start ? Math.round((Number(x.end) - start) / 1000) : undefined)
  if (!Number.isFinite(start) || start <= 0 || !durS) return null
  const out = { type: normType(x.type), start, end: start + durS * 1000, durS: Math.round(durS), d: isoOf(new Date(start)) }
  for (const f of ['distM', 'kcal', 'avgHr', 'maxHr', 'laps', 'poolM']) {
    const v = num(x[f])
    if (v !== undefined && v > 0) out[f] = f === 'distM' ? Math.round(v) : Math.round(v)
  }
  if (x.name) out.name = String(x.name).slice(0, 80)
  out.src = String(x.src || src || 'manual')
  if (x.srcId != null && x.srcId !== '') out.srcId = String(x.srcId)
  out.id = x.id || (out.srcId ? importId('as', `${out.src}|${out.srcId}`) : importId('as', `${out.src}|${out.type}|${start}`))
  return out
}

// The same session from two sources (the watch's own app and Strava, or a FIT file and an Apple
// Health export): the same kind, starting within two minutes of each other.
const SAME_START_MS = 2 * 60000
const sameSession = (a, b) => a.id === b.id || (a.type === b.type && Math.abs(a.start - b.start) <= SAME_START_MS)

/**
 * `incoming` sessions added to `current`, each once: one the profile already has (same id, or
 * the same kind starting within two minutes) is skipped. Returns the new list, newest first, and
 * how many were added.
 */
export function addSessions(current, incoming, src, now = Date.now()) {
  const out = list(current).slice()
  let added = 0
  for (const raw of list(incoming)) {
    const s = cleanSession(raw, src)
    if (!s || out.some(x => x && sameSession(x, s))) continue
    out.push({ ...s, _ts: now })
    added++
  }
  out.sort((a, b) => (b.start || 0) - (a.start || 0))
  return { sessions: out, added }
}

// ---- Reading ---------------------------------------------------------------------------------

export const dayOf = (S, d) => list(S?.activity).find(e => e?.d === d) || null

/** The last `n` days ending at `end` (ISO), oldest first, each with its record or {}. */
export function lastDays(S, n, end = isoOf(new Date())) {
  const by = new Map(list(S?.activity).map(e => [e.d, e]))
  const out = []
  const t = new Date(end + 'T12:00:00')
  for (let i = n - 1; i >= 0; i--) {
    const d = isoOf(new Date(t.getTime() - i * 86400000))
    out.push({ d, ...(by.get(d) || {}) })
  }
  return out
}

/** Sessions on or after `from` (ISO day), newest first. */
export const sessionsSince = (S, from) => list(S?.sessions).filter(s => s && s.d >= from)

/** Per kind: count, total distance (m) and time (s) over `sessions`. */
export function totalsByType(sessions) {
  const out = {}
  for (const s of list(sessions)) {
    const t = out[s.type] || (out[s.type] = { n: 0, distM: 0, durS: 0 })
    t.n++; t.distM += s.distM || 0; t.durS += s.durS || 0
  }
  return out
}

/** Average of a field over the days that have it, or null. */
export function avgOf(days, f) {
  const xs = days.map(x => x[f]).filter(v => Number.isFinite(v) && v > 0)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

// ---- Formatting ------------------------------------------------------------------------------

export const distUnitOf = S => (speedUnitOf(S) === 'mph' ? 'mi' : 'km')

/** "5.2 km", "3.1 mi"; a swim, or anything under a kilometre, in metres or yards. */
export function fmtDist(m, S, type) {
  if (!(m > 0)) return ''
  const mi = distUnitOf(S) === 'mi'
  if (type === 'swim' || m < 1000) return mi ? `${Math.round(m / 0.9144)} yd` : `${Math.round(m)} m`
  const v = mi ? m / 1000 / KMH_PER_MPH : m / 1000
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${mi ? 'mi' : 'km'}`
}

/** "1:05:30" or "42:10". */
export function fmtDur(s) {
  s = Math.round(s || 0)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const two = v => String(v).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

/** Pace for runs and walks ("5:12 /km"), per 100 m (or 100 yd) for swims, speed for rides. */
export function fmtPace(sess, S) {
  if (!(sess?.distM > 0) || !(sess?.durS > 0)) return ''
  const mi = distUnitOf(S) === 'mi'
  if (sess.type === 'ride') {
    const kmh = sess.distM / 1000 / (sess.durS / 3600)
    return `${(mi ? kmh / KMH_PER_MPH : kmh).toFixed(1)} ${mi ? 'mph' : 'km/h'}`
  }
  if (sess.type === 'swim') {
    const per = sess.durS / (sess.distM / (mi ? 91.44 : 100))
    return `${fmtDur(per)} /100${mi ? 'yd' : 'm'}`
  }
  const per = sess.durS / (sess.distM / (mi ? 1609.344 : 1000))
  return `${fmtDur(per)} /${mi ? 'mi' : 'km'}`
}

/** "7 h 20 min" */
export function fmtSleep(min) {
  if (!(min > 0)) return ''
  const h = Math.floor(min / 60), m = Math.round(min % 60)
  return h ? `${h} h ${m} min` : `${m} min`
}
