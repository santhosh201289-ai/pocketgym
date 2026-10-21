// A routine a coach sent (api/groups.js), applied to the member's own plan when they accept it.
// The routine travels as a one-routine shared-plan bundle, so it is read exactly as a plan file
// is imported (lib/plan-share.js): every exercise checked against the library or the custom
// exercises it carries, weights converted to the member's unit. Then it goes on the weekdays
// (every week) and dates (once) the coach chose, replacing what those days held, as the
// voice planner's "replace" does (lib/voice-plan.js applyPlan).
//
// Sent again (the coach changed it), it updates the routine it made last time — the one with the
// same `fromCoach.key` — instead of adding a second copy, so history and schedule keep pointing
// at one routine.
import { parsePlan, mergePlan } from './plan-share.js'
import { applyPlan } from './voice-plan.js'
import { t } from './i18n.js'

const keyOf = (a, routineId) => `${a.coachId}:${routineId}`

/** The assignment read as the member's app will apply it; throws when nothing of it is usable. */
export function readAssignment(a, unit = 'kg') {
  const parsed = parsePlan({ ...(a?.plan || {}), week: {} }, unit)
  const r = parsed.routines[0]
  if (!r || !r.ex.length) throw new Error(t('This routine has no exercises this app knows.'))
  return parsed
}

/** What accepting would put in place of what: the weekdays that already hold other routines. */
export function assignmentClashes(S, a) {
  const key = r => r.fromCoach?.key
  const name = id => (S.routines || []).find(r => r.id === id)
  const mine = (S.routines || []).find(r => key(r) === keyOf(a, a?.plan?.routines?.[0]?.id))
  return (a.weekly || [])
    .map(day => ({ day, names: [].concat(S.week?.[day] || []).filter(id => id !== mine?.id).map(id => name(id)?.name).filter(Boolean) }))
    .filter(x => x.names.length)
}

/** Applies an accepted assignment to a draft (inside update()). Returns the routine scheduled. */
export function acceptAssignment(s, a, parsed = readAssignment(a, s.unit || 'kg')) {
  const key = keyOf(a, parsed.routines[0].id)
  const before = s.routines.length
  mergePlan(s, parsed, { schedule: false })
  const fresh = s.routines.length > before ? s.routines[s.routines.length - 1] : null
  if (!fresh) return null
  const mark = { key, coach: String(a.coach || ''), group: String(a.groupName || ''), at: a.at || Date.now() }
  const old = s.routines.find(r => r !== fresh && r.fromCoach?.key === key)
  let routine = fresh
  if (old) {
    for (const f of ['name', 'emoji', 'ex', 'prog', 'excludeFromProgression']) {
      if (fresh[f] === undefined) delete old[f]; else old[f] = fresh[f]
    }
    s.routines.splice(s.routines.indexOf(fresh), 1)
    routine = old
  }
  routine.fromCoach = mark
  applyPlan(s, { ok: true, rest: false, weekly: a.weekly || [], dates: a.dates || [] }, { routine })
  return routine
}
