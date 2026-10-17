// What HealthConnectPlugin.read returns, turned into Pocket Gym's activity (lib/activity.js):
// daily totals as days, sleep sessions as each night's sleep, exercise sessions from other apps
// and watches as sessions. Pure, so it is tested without a phone (health-read.test.js).
import { isoOf } from './format.js'

const list = v => (Array.isArray(v) ? v : [])
const SRC = 'Health Connect'

/**
 * A night counts on the day it ends (last night's sleep is this morning's), minus the time
 * marked awake. Two apps that both tracked the night (the band's and the phone's) are not added
 * up: per day, the app that recorded the most sleep stands for it.
 */
export function sleepByDay(sleep) {
  const byDay = new Map() // d -> origin -> minutes
  for (const s of list(sleep)) {
    const ms = Number(s?.end) - Number(s?.start) - (Number(s?.awakeMs) || 0)
    if (!(ms > 0) || ms > 16 * 3600000) continue
    const d = isoOf(new Date(Number(s.end)))
    if (!byDay.has(d)) byDay.set(d, new Map())
    const m = byDay.get(d), o = s.origin || '?'
    m.set(o, (m.get(o) || 0) + ms / 60000)
  }
  return [...byDay].map(([d, m]) => ({ d, sleepMin: Math.round(Math.max(...m.values())) }))
}

// The package names behind the sessions, said the way people know them.
const APP_NAME = {
  'com.garmin.android.apps.connectmobile': 'Garmin Connect', 'com.strava': 'Strava',
  'com.sec.android.app.shealth': 'Samsung Health', 'com.fitbit.FitbitMobile': 'Fitbit',
  'com.huami.watch.hmwatchmanager': 'Zepp', 'com.xiaomi.wearable': 'Mi Fitness', 'com.mi.health': 'Mi Fitness',
  'com.noisefit': 'NoiseFit', 'com.google.android.apps.fitness': 'Google Fit', 'com.coros.coach': 'COROS',
  'fi.polar.polarflow': 'Polar Flow', 'com.suunto.android': 'Suunto', 'com.wahoofitness.fitness': 'Wahoo',
}
export const appName = pkg => APP_NAME[pkg] || pkg || SRC

/** `read`'s answer as { days, sessions } for mergeDays and addSessions. */
export function fromHealthConnect(res) {
  const days = new Map()
  for (const x of list(res?.days)) {
    if (!x?.d) continue
    days.set(x.d, { d: x.d, steps: x.steps, distM: x.distM, activeKcal: x.activeKcal, restHr: x.restHr })
  }
  for (const s of sleepByDay(res?.sleep)) days.set(s.d, { ...(days.get(s.d) || { d: s.d }), sleepMin: s.sleepMin })
  const sessions = list(res?.sessions).filter(s => s && s.start && s.end > s.start).map(s => ({
    type: s.type, start: s.start, durS: (s.end - s.start) / 1000,
    distM: s.distM, kcal: s.kcal, avgHr: s.avgHr, maxHr: s.maxHr,
    laps: s.type === 'swim' ? s.laps : undefined,
    name: s.title || undefined,
    src: appName(s.origin), srcId: s.id,
  }))
  return { days: [...days.values()].sort((a, b) => (a.d < b.d ? -1 : 1)), sessions }
}
