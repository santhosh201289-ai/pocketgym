// Activity imports: an Apple Health export (daily steps, distance, active energy, resting heart
// rate, sleep, and workouts), and FIT / GPX / TCX files — what Garmin Connect, Strava, Coros,
// Polar, Suunto, Zepp and most watches export for one session. Everything here is pure: text or
// bytes in, `{ days, sessions }` out, for lib/activity.js to merge (mergeDays, addSessions).
//
// Nothing throws on an odd record: a several-hundred-MB export will contain some, and losing the
// file over one of them helps nobody.

const list = v => (Array.isArray(v) ? v : [])
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : undefined }

/* ======================================================================= Apple Health ====== */

// Health dates read "2026-10-17 07:30:00 +0530". The day is the phone's own, as written; the
// instant is parsed with its offset.
const dayOfHealth = s => (/^\d{4}-\d{2}-\d{2}/.test(s || '') ? s.slice(0, 10) : null)
export function healthTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-])(\d{2}):?(\d{2})$/.exec(String(s || '').trim())
  if (m) return Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`) || null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : undefined }

const HK_SUM = {
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'distM',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'activeKcal',
}
const toMetres = (v, u) => (/^mi$/i.test(u) ? v * 1609.344 : /^km$/i.test(u) ? v * 1000 : /^yd$/i.test(u) ? v * 0.9144 : /^ft$/i.test(u) ? v * 0.3048 : v)
const toKcal = (v, u) => (/kJ/i.test(u || '') ? v / 4.184 : v)
const ASLEEP = /HKCategoryValueSleepAnalysis(Asleep|AsleepCore|AsleepDeep|AsleepREM|AsleepUnspecified)$/

const HK_WORKOUT = {
  Running: 'run', Walking: 'walk', Cycling: 'ride', Swimming: 'swim', Hiking: 'hike',
  WheelchairRunPace: 'run', WheelchairWalkPace: 'walk', HandCycling: 'ride',
}

/**
 * Daily totals and workouts from Apple Health's `export.xml`. A day's steps from the iPhone and
 * the watch overlap — Health counts each step once by deduplicating sources, which this file does
 * not show — so a day's total is taken from the one source that counted the most, not summed.
 */
export function parseAppleHealthActivity(text) {
  const s = String(text)
  if (!s.includes('HKQuantityTypeIdentifier') && !s.includes('<Workout')) return { error: 'unrecognised' }
  // per field, per day, per source: the running sum
  const sums = { steps: new Map(), distM: new Map(), activeKcal: new Map(), sleepMin: new Map() }
  const add = (f, d, src, v) => {
    const byDay = sums[f]
    if (!byDay.has(d)) byDay.set(d, new Map())
    const m = byDay.get(d)
    m.set(src, (m.get(src) || 0) + v)
  }
  const restHr = new Map()
  const re = /<Record\s[^>]*>/g
  let m
  while ((m = re.exec(s))) {
    const tag = m[0]
    const type = attr(tag, 'type')
    if (!type) continue
    const src = attr(tag, 'sourceName') || '?'
    if (HK_SUM[type]) {
      const d = dayOfHealth(attr(tag, 'startDate'))
      let v = n(attr(tag, 'value'))
      if (!d || !(v > 0)) continue
      const f = HK_SUM[type], u = attr(tag, 'unit')
      if (f === 'distM') v = toMetres(v, u)
      if (f === 'activeKcal') v = toKcal(v, u)
      add(f, d, src, v)
    } else if (type === 'HKQuantityTypeIdentifierRestingHeartRate') {
      const d = dayOfHealth(attr(tag, 'startDate')), v = n(attr(tag, 'value'))
      if (d && v > 20 && v < 200) restHr.set(d, v)
    } else if (type === 'HKCategoryTypeIdentifierSleepAnalysis' && ASLEEP.test(attr(tag, 'value') || '')) {
      // A night counts on the day it ends: last night's sleep is this morning's.
      const a = healthTime(attr(tag, 'startDate')), b = healthTime(attr(tag, 'endDate'))
      const d = dayOfHealth(attr(tag, 'endDate'))
      if (d && a && b > a && b - a < 16 * 3600000) add('sleepMin', d, src, (b - a) / 60000)
    }
  }
  const days = new Map()
  const day = d => days.get(d) || (days.set(d, { d }), days.get(d))
  for (const [f, byDay] of Object.entries(sums)) {
    for (const [d, bySrc] of byDay) {
      const v = Math.max(...bySrc.values())
      if (f === 'sleepMin' && v > 16 * 60) continue
      day(d)[f] = v
    }
  }
  for (const [d, v] of restHr) day(d).restHr = v

  const sessions = []
  const wre = /<Workout\s[^>]*?(\/>|>([\s\S]*?)<\/Workout>)/g
  while ((m = wre.exec(s))) {
    const open = /<Workout\s[^>]*>/.exec(m[0])[0]
    const body = m[2] || ''
    const kind = (attr(open, 'workoutActivityType') || '').replace('HKWorkoutActivityType', '')
    const start = healthTime(attr(open, 'startDate')), end = healthTime(attr(open, 'endDate'))
    if (!start) continue
    let durS = n(attr(open, 'duration'))
    const du = attr(open, 'durationUnit') || 'min'
    if (durS != null) durS = /min/i.test(du) ? durS * 60 : /^h/i.test(du) ? durS * 3600 : durS
    else if (end > start) durS = (end - start) / 1000
    if (!(durS > 0)) continue
    let distM = n(attr(open, 'totalDistance'))
    if (distM != null) distM = toMetres(distM, attr(open, 'totalDistanceUnit') || 'km')
    let kcal = n(attr(open, 'totalEnergyBurned'))
    if (kcal != null) kcal = toKcal(kcal, attr(open, 'totalEnergyBurnedUnit'))
    let avgHr, maxHr
    // Newer exports carry the totals in <WorkoutStatistics> children instead.
    for (const st of body.match(/<WorkoutStatistics\s[^>]*>/g) || []) {
      const ty = attr(st, 'type') || ''
      if (/Distance/.test(ty) && distM == null) distM = toMetres(n(attr(st, 'sum')) || 0, attr(st, 'unit') || 'km') || undefined
      else if (/ActiveEnergyBurned/.test(ty) && kcal == null) kcal = toKcal(n(attr(st, 'sum')) || 0, attr(st, 'unit')) || undefined
      else if (/HeartRate/.test(ty)) { avgHr = n(attr(st, 'average')); maxHr = n(attr(st, 'maximum')) }
    }
    const lap = /HKLapLength"\s+value="([\d.]+)\s*(\w+)"/.exec(body)
    sessions.push({
      type: HK_WORKOUT[kind] || 'other', start, durS, distM, kcal, avgHr, maxHr,
      ...(lap ? { poolM: toMetres(n(lap[1]), lap[2]) } : {}),
      name: kind && !HK_WORKOUT[kind] ? kind.replace(/([a-z])([A-Z])/g, '$1 $2') : undefined,
      src: 'Apple Health', srcId: `${kind}|${start}`,
    })
  }
  const out = [...days.values()].sort((a, b) => (a.d < b.d ? -1 : 1))
  if (!out.length && !sessions.length) return { error: 'empty' }
  return { kind: 'activity', source: 'Apple Health', days: out, sessions }
}

/* ================================================================================ FIT ====== */

// FIT, the binary format every Garmin (and most other watches) writes. Only the `session`
// message is read: one per activity, with its totals. Laps, records and GPS are skipped.
const FIT_EPOCH = 631065600 // 1989-12-31T00:00:00Z, in Unix seconds
const FIT_SPORT = { 1: 'run', 2: 'ride', 5: 'swim', 11: 'walk', 17: 'hike' }
const FIT_SPORT_NAME = {
  0: 'Workout', 3: 'Transition', 4: 'Fitness equipment', 6: 'Basketball', 7: 'Soccer', 8: 'Tennis', 10: 'Training',
  12: 'Cross-country skiing', 13: 'Alpine skiing', 15: 'Rowing', 16: 'Mountaineering', 19: 'Paddling', 37: 'Stand-up paddling',
}
const INVALID = { 1: 0xff, 2: 0xffff, 4: 0xffffffff }

export function parseFit(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (u8.length < 14) return { error: 'unrecognised' }
  const hs = u8[0]
  if (String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== '.FIT' || (hs !== 12 && hs !== 14)) return { error: 'unrecognised' }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const end = Math.min(u8.length, hs + dv.getUint32(4, true))
  const defs = {}
  const sessions = []
  let p = hs
  const uint = (at, size, le) => (size === 1 ? dv.getUint8(at) : size === 2 ? dv.getUint16(at, le) : size === 4 ? dv.getUint32(at, le) : undefined)
  try {
    while (p < end) {
      const h = u8[p++]
      if (h & 0x80) { // compressed-timestamp data message
        const def = defs[(h >> 5) & 3]
        if (!def) break
        p = readData(def, p)
        continue
      }
      const local = h & 0x0f
      if (h & 0x40) { // definition
        const le = u8[p + 1] === 0
        const global = dv.getUint16(p + 2, le)
        const count = u8[p + 4]
        p += 5
        const fields = []
        for (let i = 0; i < count; i++, p += 3) fields.push({ num: u8[p], size: u8[p + 1] })
        let devSize = 0
        if (h & 0x20) {
          const dc = u8[p++]
          for (let i = 0; i < dc; i++, p += 3) devSize += u8[p + 1]
        }
        defs[local] = { le, global, fields, devSize }
      } else {
        const def = defs[local]
        if (!def) break
        p = readData(def, p)
      }
    }
  } catch { /* a truncated file: keep what was read */ }

  function readData(def, at) {
    if (def.global !== 18) return at + def.fields.reduce((a, f) => a + f.size, 0) + def.devSize
    const v = {}
    for (const f of def.fields) {
      const x = uint(at, f.size, def.le)
      if (x !== undefined && x !== INVALID[f.size]) v[f.num] = x
      at += f.size
    }
    if (v[2] != null) {
      const elapsed = (v[7] ?? v[8]) != null ? (v[7] ?? v[8]) / 1000 : undefined
      sessions.push({
        type: FIT_SPORT[v[5]] || 'other', start: (v[2] + FIT_EPOCH) * 1000, durS: elapsed,
        distM: v[9] != null ? v[9] / 100 : undefined, kcal: v[11], avgHr: v[16], maxHr: v[17],
        laps: v[5] === 5 ? v[26] : undefined, poolM: v[44] != null ? v[44] / 100 : undefined,
        name: FIT_SPORT[v[5]] ? undefined : FIT_SPORT_NAME[v[5]],
        src: 'FIT', srcId: String(v[2] + FIT_EPOCH),
      })
    }
    return at + def.devSize
  }
  if (!sessions.length) return { error: 'empty' }
  return { kind: 'activity', source: 'FIT', days: [], sessions }
}

/* ======================================================================== GPX / TCX ====== */

const typeOfName = s => {
  s = String(s || '').toLowerCase()
  return /run|jog/.test(s) ? 'run' : /walk/.test(s) ? 'walk' : /bik|cycl|ride/.test(s) ? 'ride' : /swim/.test(s) ? 'swim' : /hik/.test(s) ? 'hike' : 'other'
}
const haversine = (a, b) => {
  const R = 6371000, r = x => (x * Math.PI) / 180
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function parseGpx(text) {
  const s = String(text)
  if (!/<gpx[\s>]/.test(s)) return { error: 'unrecognised' }
  const sessions = []
  for (const trk of s.match(/<trk[\s>][\s\S]*?<\/trk>/g) || []) {
    const pts = []
    for (const m of trk.matchAll(/<trkpt\s+([^>]*)>([\s\S]*?)<\/trkpt>/g)) {
      const lat = n(attr(' ' + m[1], 'lat')), lon = n(attr(' ' + m[1], 'lon'))
      const tm = /<time>([^<]+)<\/time>/.exec(m[2])
      const hr = /<(?:\w+:)?hr>(\d+)<\/(?:\w+:)?hr>/.exec(m[2])
      if (lat == null || lon == null) continue
      pts.push({ lat, lon, t: tm ? Date.parse(tm[1]) : null, hr: hr ? +hr[1] : null })
    }
    const timed = pts.filter(x => x.t)
    if (timed.length < 2) continue
    let distM = 0
    for (let i = 1; i < pts.length; i++) distM += haversine(pts[i - 1], pts[i])
    const hrs = pts.map(x => x.hr).filter(Boolean)
    const name = (/<name>([^<]*)<\/name>/.exec(trk) || [])[1]
    const ty = (/<type>([^<]*)<\/type>/.exec(trk) || [])[1]
    const start = timed[0].t
    sessions.push({
      type: typeOfName(ty || name), start, durS: (timed[timed.length - 1].t - start) / 1000, distM,
      avgHr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : undefined,
      maxHr: hrs.length ? Math.max(...hrs) : undefined, name, src: 'GPX', srcId: String(start),
    })
  }
  if (!sessions.length) return { error: 'empty' }
  return { kind: 'activity', source: 'GPX', days: [], sessions }
}

export function parseTcx(text) {
  const s = String(text)
  if (!/<TrainingCenterDatabase[\s>]/.test(s)) return { error: 'unrecognised' }
  const sessions = []
  for (const act of s.match(/<Activity\s[\s\S]*?<\/Activity>/g) || []) {
    const sport = attr(act.slice(0, 200), 'Sport')
    const laps = act.match(/<Lap\s[\s\S]*?<\/Lap>/g) || []
    if (!laps.length) continue
    const start = Date.parse(attr(laps[0].slice(0, 200), 'StartTime') || (/<Id>([^<]+)<\/Id>/.exec(act) || [])[1])
    if (!start) continue
    let durS = 0, distM = 0, kcal = 0, maxHr = 0, hrW = 0
    for (const lap of laps) {
      const secs = n((/<TotalTimeSeconds>([^<]+)</.exec(lap) || [])[1]) || 0
      durS += secs
      distM += n((/<DistanceMeters>([^<]+)</.exec(lap) || [])[1]) || 0
      kcal += n((/<Calories>([^<]+)</.exec(lap) || [])[1]) || 0
      const avg = n((/<AverageHeartRateBpm>\s*<Value>([^<]+)</.exec(lap) || [])[1])
      const mx = n((/<MaximumHeartRateBpm>\s*<Value>([^<]+)</.exec(lap) || [])[1])
      if (avg) hrW += avg * secs
      if (mx > maxHr) maxHr = mx
    }
    sessions.push({
      type: typeOfName(sport), start, durS, distM: distM || undefined, kcal: kcal || undefined,
      avgHr: hrW && durS ? Math.round(hrW / durS) : undefined, maxHr: maxHr || undefined,
      laps: typeOfName(sport) === 'swim' ? laps.length : undefined, src: 'TCX', srcId: String(start),
    })
  }
  if (!sessions.length) return { error: 'empty' }
  return { kind: 'activity', source: 'TCX', days: [], sessions }
}

/* ===================================================================== by file ====== */

/** Whether a file name looks like something this module reads. */
export const isActivityFile = name => /\.(fit|gpx|tcx|xml)$/i.test(name || '')

/**
 * Any number of files, read and parsed by kind, combined. `read(file)` returns its bytes
 * (ArrayBuffer) — a FileReader in the app, a buffer in tests. Files that are none of these, or
 * hold nothing, are counted in `skipped`.
 */
export async function parseActivityFiles(files, read) {
  const days = [], sessions = []
  const sources = new Set()
  let skipped = 0
  for (const f of list(files)) {
    let r
    try {
      const bytes = new Uint8Array(await read(f))
      if (/\.fit$/i.test(f.name) || (bytes.length > 12 && String.fromCharCode(...bytes.slice(8, 12)) === '.FIT')) r = parseFit(bytes)
      else {
        const text = new TextDecoder().decode(bytes)
        r = /<TrainingCenterDatabase/.test(text) ? parseTcx(text)
          : /<gpx[\s>]/.test(text) ? parseGpx(text)
          : parseAppleHealthActivity(text)
      }
    } catch { r = { error: 'unreadable' } }
    if (!r || r.error) { skipped++; continue }
    days.push(...r.days); sessions.push(...r.sessions); sources.add(r.source)
  }
  return { days, sessions, sources: [...sources], skipped }
}
