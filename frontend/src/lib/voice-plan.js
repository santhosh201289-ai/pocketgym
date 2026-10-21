// Planning by voice (or typed): "add a push workout on Tuesday", "legs every Friday", "pull day
// tomorrow", "rest on Sunday". Pure: the words become a request (parseRequest), the request
// meets the profile (planRequest: which routine, which days, what is there already), and only
// then, after the person has seen it, does the plan change (applyPlan, inside update()).
//
// A weekday on its own is the weekly plan, every week: "push on Tuesday" puts Push on S.week[2].
// A day with a date in it — today, tomorrow, "this Friday", "next Monday" — is that day only, the
// same per-date override the day sheet sets (S.dayPlan[iso]). English only: the recogniser is
// asked for English, and the words below are English.
import { isoOf } from './format.js'
import { STARTER_KINDS } from './starter.js'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 }

const dayIndex = w => {
  const i = WEEKDAYS.indexOf(w)
  if (i >= 0) return i
  if (w.endsWith('s') && WEEKDAYS.includes(w.slice(0, -1))) return WEEKDAYS.indexOf(w.slice(0, -1))
  return SHORT[w] ?? null
}
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d) }
const weekdayOf = iso => new Date(iso + 'T12:00:00').getDay()

// Words that carry no part of the routine's name.
const FILLER = new Set(('add put set schedule plan make give do please can could you i want would like to me my for on at in '
  + 'a an the this that next coming upcoming every each weekly also and with workout workouts routine routines session sessions '
  + 'training train day days of week weeks it be is are will should just change move switch replace').split(' '))
const REST = /\b(rest|day off|off day|no (?:workout|training|gym)|skip|nothing|free day|clear|remove|cancel)\b/

/**
 * The words as a request, or { ok: false, reason } — 'empty', 'no-day' or 'no-workout'.
 * { ok: true, rest, query, weekly: [weekday], dates: [iso] }. `today` is an ISO date.
 */
export function parseRequest(text, today) {
  let s = String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9× ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return { ok: false, reason: 'empty' }
  const weekly = new Set(), dates = new Set()
  const take = re => { let m; const out = []; while ((m = re.exec(s))) out.push(m); s = s.replace(re, ' '); return out }

  for (const _ of take(/\bday after tomorrow\b/g)) dates.add(addDays(today, 2))
  for (const _ of take(/\b(today|tonight)\b/g)) dates.add(today)
  for (const _ of take(/\btomorrow\b/g)) dates.add(addDays(today, 1))
  for (const _ of take(/\b(every ?day|daily)\b/g)) for (let d = 0; d < 7; d++) weekly.add(d)
  for (const _ of take(/\b(weekdays|every weekday|week days)\b/g)) for (let d = 1; d <= 5; d++) weekly.add(d)
  for (const _ of take(/\b(weekends?|every weekend)\b/g)) { weekly.add(0); weekly.add(6) }
  // "this Friday" (today counts) and "next Monday" (after today): one date each.
  for (const m of take(/\b(this|next|coming) ([a-z]+)\b/g)) {
    const d = dayIndex(m[2])
    if (d == null) { s += ' ' + m[2]; continue }
    let n = (d - weekdayOf(today) + 7) % 7
    if (m[1] !== 'this' && n === 0) n = 7
    dates.add(addDays(today, n))
  }
  // Any other weekday: every week.
  s = s.split(' ').filter(w => {
    const d = dayIndex(w)
    if (d == null) return true
    weekly.add(d)
    return false
  }).join(' ')

  const rest = REST.test(s)
  const query = rest ? '' : s.replace(REST, ' ').split(' ').filter(w => w && !FILLER.has(w)).join(' ')
  if (!weekly.size && !dates.size) return { ok: false, reason: 'no-day', query }
  if (!rest && !query) return { ok: false, reason: 'no-workout' }
  return { ok: true, rest, query, weekly: [...weekly].sort(), dates: [...dates].sort() }
}

// "legs", "leg", "lower body" → one kind; names are compared by these.
const KIND = [
  ['push', /\b(push|chest|tricep|triceps)\b/],
  ['pull', /\b(pull|back|bicep|biceps)\b/],
  ['legs', /\b(legs?|squat|glutes?|quads?|hamstrings?)\b/],
  ['upper', /\bupper\b/],
  ['lower', /\blower\b/],
  ['full body', /\b(full ?body|total ?body|whole ?body)\b/],
  ['5x5', /\b(5 ?x ?5|5×5|five by five)\b/],
]
const kindOf = text => KIND.find(([, re]) => re.test(text))?.[0] || null
const tokens = text => String(text || '').toLowerCase().replace(/[^a-z0-9× ]+/g, ' ').split(/\s+/)
  .filter(w => w && !FILLER.has(w)).map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))

/** The profile's routine the words name best, or null. */
export function matchRoutine(routines, query) {
  const want = new Set(tokens(query))
  const kind = kindOf(query)
  let best = null, bestScore = 0
  for (const r of routines || []) {
    if (!r || !r.name) continue
    const name = r.name.toLowerCase()
    const have = tokens(name)
    let score = have.filter(w => want.has(w)).length * 2
    if (kind && kindOf(name) === kind) score += 3
    if (name.trim() === String(query).trim()) score += 5
    if (score > bestScore) { best = r; bestScore = score }
  }
  return best
}

/**
 * The request against the profile: { ok, routine | null, make: kind | null, rest, weekly, dates,
 * busy: [{ day, names }] } — `make` names a starter template to create when no routine matches,
 * `busy` the weekdays that already hold other routines. Or { ok: false, reason: 'unknown', query }.
 */
export function planRequest(S, req) {
  if (!req?.ok) return req
  const base = { ok: true, rest: req.rest, weekly: req.weekly, dates: req.dates }
  if (req.rest) return { ...base, routine: null, make: null, busy: [] }
  const routine = matchRoutine(S.routines, req.query)
  const kind = routine ? null : kindOf(req.query)
  if (!routine && !STARTER_KINDS.includes(kind)) return { ok: false, reason: 'unknown', query: req.query }
  const name = id => (S.routines || []).find(r => r.id === id)?.name
  const busy = req.weekly
    .map(day => ({ day, ids: [].concat(S.week?.[day] || []).filter(id => id !== routine?.id && name(id)) }))
    .filter(x => x.ids.length)
    .map(({ day, ids }) => ({ day, names: ids.map(name) }))
  return { ...base, routine, make: kind, busy }
}

/**
 * The plan changed as asked, on a draft (inside update()). `routine` is the one to schedule —
 * the matched one, or one just made from `make` (added to the profile here). `combine` keeps the
 * routines a weekday already has and adds this one after them; otherwise it replaces them.
 */
export function applyPlan(s, plan, { routine = plan.routine, combine = false } = {}) {
  if (!plan?.ok) return
  if (!s.week) s.week = {}
  if (!s.dayPlan) s.dayPlan = {}
  if (routine && !s.routines.some(r => r.id === routine.id)) s.routines.push(routine)
  for (const day of plan.weekly) {
    if (plan.rest) { delete s.week[day]; continue }
    const ids = combine ? [].concat(s.week[day] || []).filter(id => id !== routine.id) : []
    s.week[day] = [...ids, routine.id]
  }
  for (const iso of plan.dates) s.dayPlan[iso] = plan.rest ? 'rest' : routine.id
}
