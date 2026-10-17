// Health Connect on the Android app (#200): turning it on, and keeping it in step with the log.
// What gets written is worked out in lib/health-connect.js; this file owns the native plugin
// (HealthConnectPlugin.java) and the phone's own record of what it wrote.
//
// It is a fact about this phone, not about the training log: kept in its own file in the app's
// data directory, never in S, so it does not sync to a server, ride in a backup, or switch on a
// second phone. Off until the user turns it on; nothing is asked of Health Connect before that.
//
// The web build never gets here (MOBILE is a build-time flag), and iOS answers 'unsupported'.
import { MOBILE, isAndroid, readJsonFile, writeJsonFile } from './mobile.js'
import { healthRecords, planSync, writtenIds } from './health-connect.js'
import { exerciseNameFor } from './i18n-core.js'
import { EXIDX } from './exercises.js'
import { speedUnitOf } from './speed.js'
import { fromHealthConnect } from './health-read.js'
import { mergeDays, addSessions } from './activity.js'

export const HEALTH_FILE = 'pocketgym-health.json'
const OFF = { on: false, written: {}, at: 0, error: null, readOn: false, readAt: 0, readError: null }

// Wrapped in an object, as in rest-alert.js: a Capacitor plugin proxy answers `then`, so a
// promise resolved with the bare proxy never settles.
let pluginP = null
const plugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid())) return null
  const { registerPlugin } = await import('@capacitor/core')
  return { HC: registerPlugin('HealthConnect') }
})().catch(() => null))

// The file's content, read once and then kept here: a save while it is off (the usual case) must
// not cost a file read, and every change to it goes through saveHealth anyway.
let cached = null
export async function loadHealth() {
  if (cached) return cached
  const f = await readJsonFile(HEALTH_FILE)
  cached = f && typeof f === 'object' ? { ...OFF, ...f, written: f.written && typeof f.written === 'object' ? f.written : {} } : { ...OFF }
  return cached
}
const saveHealth = h => { cached = h; return writeJsonFile(HEALTH_FILE, h) }

/** { status: 'available' | 'update' | 'missing' | 'unsupported', granted } */
export async function healthStatus() {
  if (!MOBILE) return { status: 'unsupported', granted: false }
  try {
    const p = await plugin()
    if (!p) return { status: 'unsupported', granted: false }
    return await p.HC.status()
  } catch { return { status: 'unsupported', granted: false } }
}

/** Health Connect's own screen for what apps wrote, or its store page where it is missing. */
export async function openHealthConnect() {
  const p = await plugin()
  if (p) await p.HC.openSettings()
}

const nameOf = e => (EXIDX[e.id] ? exerciseNameFor(EXIDX[e.id]) : (e.n || e.id))

// One sync at a time. A change that comes in while one runs is not lost: the running one is
// followed by a single further pass with the newest state.
let running = null
let again = null
const listeners = new Set()
/** Called with the file's new content after every sync, for the Settings row. */
export function onHealthChange(cb) { listeners.add(cb); return () => listeners.delete(cb) }
const told = h => { listeners.forEach(cb => { try { cb(h) } catch { /* a closed screen */ } }) }

/**
 * Writes what changed since the last sync and removes what was deleted from Pocket Gym. A no-op
 * while it is off. Resolves with the file's content afterwards; `error` is 'permission' when
 * Health Connect refused (the user took the permission back), 'unavailable' when it is gone.
 */
export function syncHealth(S) {
  if (!MOBILE) return Promise.resolve(null)
  // Not read yet: initHealthSync reads it at launch and syncs then, which covers a save made
  // before that; the save path itself never waits on the file.
  if (!cached || !cached.on) return Promise.resolve(cached)
  if (running) { again = S; return running }
  again = null
  running = (async () => {
    let h = await loadHealth()
    let next = S
    while (next) {
      if (h.on) h = await syncOnce(next, h)
      // A state that came in meanwhile, taken only now: cleared before a pass, it would lose a
      // change made while the pass was starting.
      next = again
      again = null
    }
    return h
  })().finally(() => { running = null })
  return running
}

async function syncOnce(S, h) {
  const p = await plugin()
  if (!p) return h
  const plan = planSync(healthRecords(S, { nameOf, speedUnit: speedUnitOf(S) }), h.written)
  const nothing = !plan.sessions.length && !plan.weights.length && !plan.remove.sessions.length && !plan.remove.weights.length
  if (nothing) {
    if (!h.error) return h
    // Nothing to write, but the last attempt failed: clear it once Health Connect says yes again.
    const st = await p.HC.status().catch(() => null)
    if (!(st?.status === 'available' && st.granted)) return h
    const out = { ...h, error: null }
    await saveHealth(out)
    told(out)
    return out
  }
  let out = { ...h }
  try {
    if (plan.sessions.length || plan.weights.length) {
      await p.HC.write({ sessions: plan.sessions, weights: plan.weights })
      // Written but not yet removed: kept as written, so a failed remove is tried again.
      const kept = Object.fromEntries(Object.entries(h.written).filter(([id]) => !plan.written[id]))
      out.written = { ...kept, ...plan.written }
    }
    if (plan.remove.sessions.length || plan.remove.weights.length) await p.HC.remove(plan.remove)
    out = { ...out, written: plan.written, at: Date.now(), error: null }
  } catch (e) {
    out.error = e?.code === 'permission' ? 'permission' : e?.code === 'unavailable' ? 'unavailable' : 'failed'
  }
  await saveHealth(out)
  told(out)
  return out
}

/**
 * Turning it on: asks for the two write permissions, then writes the whole log once. Resolves
 * with { ok, reason } — reason 'denied' when the user did not grant both, or the status when
 * Health Connect is not there to ask.
 */
export async function enableHealth(S) {
  const p = await plugin()
  if (!p) return { ok: false, reason: 'unsupported' }
  const st = await p.HC.status().catch(() => ({ status: 'unsupported' }))
  if (st.status !== 'available') return { ok: false, reason: st.status }
  const granted = st.granted || (await p.HC.requestPermissions().catch(() => ({ granted: false }))).granted
  if (!granted) return { ok: false, reason: 'denied' }
  const h = await loadHealth()
  await saveHealth({ ...h, on: true, error: null })
  const after = await syncHealth(S)
  return { ok: !after?.error, reason: after?.error || null, health: after }
}

/**
 * Turning it off stops the writing. With `removeWritten`, what Pocket Gym wrote is taken out of
 * Health Connect too; without it, it stays there as the user's own data. Rejects when the
 * removal fails, and then stays on, so nothing is left behind that the phone forgot it wrote.
 */
export async function disableHealth({ removeWritten = false } = {}) {
  if (running) await running.catch(() => {})
  const h = await loadHealth()
  if (removeWritten) {
    const ids = writtenIds(h.written)
    if (ids.sessions.length || ids.weights.length) {
      const p = await plugin()
      if (!p) throw new Error('unavailable')
      await p.HC.remove(ids)
    }
  }
  const out = { ...h, on: false, error: null, written: removeWritten ? {} : h.written }
  await saveHealth(out)
  told(out)
  return out
}

/* ---------------------------------------------------------------- reading ------------------ */
// The other direction: steps, sleep, resting heart rate and the sessions other apps and watches
// log (NoiseFit, Zepp, Samsung Health, Fitbit, Garmin Connect…) come into S.activity and
// S.sessions, which sync to the server like everything else. Off until the user turns it on;
// the read permissions are asked for on their own, apart from the write side's.

// How far back the first read goes, and how much each later one overlaps the last, so a band
// that syncs to its app hours late still lands. Health Connect itself lets an app read 30 days
// before its permission was granted.
const FIRST_DAYS = 30
const OVERLAP_MS = 2 * 86400000
// Not more often than this from the foreground listener; "Sync now" always reads.
const PULL_EVERY_MS = 15 * 60000
let applyFn = null
let pulling = null

/**
 * Reads what Health Connect holds since the last read and merges it in. Resolves with
 * { days, sessions } — how many days changed and sessions were added — or null while it is off.
 */
export function pullHealth({ force = false } = {}) {
  if (!MOBILE) return Promise.resolve(null)
  if (pulling) return pulling
  pulling = (async () => {
    const h = await loadHealth()
    if (!h.readOn || !applyFn) return null
    if (!force && Date.now() - (h.readAt || 0) < PULL_EVERY_MS) return null
    const p = await plugin()
    if (!p) return null
    const since = h.readAt ? h.readAt - OVERLAP_MS : Date.now() - FIRST_DAYS * 86400000
    let res
    try { res = await p.HC.read({ since }) } catch (e) {
      const out = { ...h, readError: e?.code === 'permission' ? 'permission' : e?.code === 'unavailable' ? 'unavailable' : 'failed' }
      await saveHealth(out); told(out)
      return null
    }
    const got = fromHealthConnect(res)
    let counts = { days: 0, sessions: 0 }
    applyFn(st => {
      const d = mergeDays(st.activity || [], got.days, 'Health Connect')
      const a = addSessions(st.sessions || [], got.sessions, 'Health Connect')
      if (d.changed) st.activity = d.activity
      if (a.added) st.sessions = a.sessions
      counts = { days: d.changed, sessions: a.added }
    })
    const out = { ...(await loadHealth()), readAt: Date.now(), readError: null }
    await saveHealth(out); told(out)
    return counts
  })().finally(() => { pulling = null })
  return pulling
}

/** Turning reading on: asks for the read permissions, then reads the last 30 days once. */
export async function enableHealthRead() {
  const p = await plugin()
  if (!p) return { ok: false, reason: 'unsupported' }
  const st = await p.HC.status().catch(() => ({ status: 'unsupported' }))
  if (st.status !== 'available') return { ok: false, reason: st.status }
  let kinds = null
  if (!st.readGranted) {
    const r = await p.HC.requestReadPermissions().catch(() => ({ granted: false, kinds: [] }))
    kinds = r.kinds || []
    // Partly granted is still worth reading (steps without sleep); nothing granted is not.
    if (!r.granted && !kinds.length) return { ok: false, reason: 'denied' }
  }
  const h = await loadHealth()
  await saveHealth({ ...h, readOn: true, readAt: 0, readError: null })
  const counts = await pullHealth({ force: true })
  return { ok: true, counts, partial: !!kinds && kinds.length < 7 }
}

/** Turning reading off. What was already imported stays in the log. */
export async function disableHealthRead() {
  if (pulling) await pulling.catch(() => {})
  const h = await loadHealth()
  const out = { ...h, readOn: false, readError: null }
  await saveHealth(out); told(out)
  return out
}

// Back in the foreground: a change synced from another device while the phone was away, or a
// permission the user granted again in Health Connect's own settings, is picked up then.
let started = false
export function initHealthSync(getState, apply) {
  if (!MOBILE || started) return
  started = true
  applyFn = apply || null
  import('@capacitor/app').then(({ App }) => {
    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      syncHealth(getState()).catch(() => {})
      pullHealth().catch(() => {})
    })
  }).catch(() => {})
  setTimeout(() => pullHealth().catch(() => {}), 4000)
  // Once at launch, for a workout finished just before the app was closed. Reading the file here
  // also settles whether it is on, which the saves wait for (syncHealth).
  setTimeout(() => loadHealth().then(() => syncHealth(getState())).catch(() => {}), 3000)
}
