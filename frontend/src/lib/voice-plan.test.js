import { describe, expect, it } from 'vitest'
import { parseRequest, matchRoutine, planRequest, applyPlan } from './voice-plan.js'
import { starterRoutine } from './starter.js'

// 2026-10-21 is a Wednesday.
const TODAY = '2026-10-21'
const routines = [
  { id: 'p', name: 'Push Day', ex: [] },
  { id: 'l', name: 'Leg Day', ex: [] },
  { id: 'u', name: 'Upper body A', ex: [] },
]

describe('parseRequest', () => {
  it('a weekday on its own is every week', () => {
    expect(parseRequest('Add a push workout for Tuesday', TODAY)).toEqual({ ok: true, rest: false, query: 'push', weekly: [2], dates: [] })
    expect(parseRequest('legs on monday and thursday', TODAY).weekly).toEqual([1, 4])
    expect(parseRequest('upper body every Friday', TODAY)).toMatchObject({ query: 'upper body', weekly: [5] })
    expect(parseRequest('pull on Mondays', TODAY).weekly).toEqual([1])
    expect(parseRequest('full body on weekdays', TODAY).weekly).toEqual([1, 2, 3, 4, 5])
    expect(parseRequest('push on tues', TODAY).weekly).toEqual([2])
  })

  it('a day with a date in it is that day only', () => {
    expect(parseRequest('add pull day tomorrow', TODAY)).toMatchObject({ query: 'pull', weekly: [], dates: ['2026-10-22'] })
    expect(parseRequest('legs today', TODAY).dates).toEqual([TODAY])
    expect(parseRequest('push this wednesday', TODAY).dates).toEqual([TODAY])
    expect(parseRequest('push next wednesday', TODAY).dates).toEqual(['2026-10-28'])
    expect(parseRequest('push next friday', TODAY).dates).toEqual(['2026-10-23'])
    expect(parseRequest('legs the day after tomorrow', TODAY).dates).toEqual(['2026-10-23'])
  })

  it('rest days', () => {
    expect(parseRequest('rest on Sunday', TODAY)).toEqual({ ok: true, rest: true, query: '', weekly: [0], dates: [] })
    expect(parseRequest('no workout tomorrow', TODAY)).toMatchObject({ rest: true, dates: ['2026-10-22'] })
  })

  it('says what is missing', () => {
    expect(parseRequest('', TODAY)).toEqual({ ok: false, reason: 'empty' })
    expect(parseRequest('add a push workout', TODAY)).toEqual({ ok: false, reason: 'no-day', query: 'push' })
    expect(parseRequest('add a workout on friday', TODAY)).toEqual({ ok: false, reason: 'no-workout' })
  })
})

describe('matchRoutine', () => {
  it('by the words of its name, and by kind', () => {
    expect(matchRoutine(routines, 'push').id).toBe('p')
    expect(matchRoutine(routines, 'legs').id).toBe('l')
    expect(matchRoutine(routines, 'squat').id).toBe('l')
    expect(matchRoutine(routines, 'chest').id).toBe('p')
    expect(matchRoutine(routines, 'upper').id).toBe('u')
    expect(matchRoutine(routines, 'yoga')).toBeNull()
  })
})

describe('planRequest and applyPlan', () => {
  const S = () => ({ routines: routines.map(r => ({ ...r })), week: { 2: ['l'], 4: ['p'] }, dayPlan: {} })

  it('puts a matched routine on a weekday, replacing or combining what is there', () => {
    const st = S()
    const plan = planRequest(st, parseRequest('push on tuesday', TODAY))
    expect(plan.routine.id).toBe('p')
    expect(plan.busy).toEqual([{ day: 2, names: ['Leg Day'] }])
    const a = S(); applyPlan(a, plan); expect(a.week[2]).toEqual(['p'])
    const b = S(); applyPlan(b, plan, { combine: true }); expect(b.week[2]).toEqual(['l', 'p'])
    // Already there: nothing busy, nothing doubled.
    const again = planRequest(st, parseRequest('push on thursday', TODAY))
    expect(again.busy).toEqual([])
    const c = S(); applyPlan(c, again, { combine: true }); expect(c.week[4]).toEqual(['p'])
  })

  it('a date is an override for that day only', () => {
    const st = S()
    const plan = planRequest(st, parseRequest('legs tomorrow', TODAY))
    applyPlan(st, plan)
    expect(st.dayPlan).toEqual({ '2026-10-22': 'l' })
    expect(st.week).toEqual({ 2: ['l'], 4: ['p'] })
  })

  it('rest clears a weekday, or rests a date', () => {
    const st = S()
    applyPlan(st, planRequest(st, parseRequest('rest on tuesday and tomorrow', TODAY)))
    expect(st.week[2]).toBeUndefined()
    expect(st.dayPlan['2026-10-22']).toBe('rest')
  })

  it('no such routine: a starter one of that kind is made', () => {
    const st = { routines: [], week: {}, dayPlan: {} }
    const plan = planRequest(st, parseRequest('add a pull workout on friday', TODAY))
    expect(plan).toMatchObject({ ok: true, routine: null, make: 'pull' })
    const made = starterRoutine(plan.make)
    expect(made.name).toBe('Pull Day')
    expect(made.ex.length).toBeGreaterThan(0)
    applyPlan(st, plan, { routine: made })
    expect(st.routines).toHaveLength(1)
    expect(st.week[5]).toEqual([made.id])
  })

  it('nothing it can make: says so', () => {
    expect(planRequest({ routines, week: {} }, parseRequest('yoga on friday', TODAY))).toEqual({ ok: false, reason: 'unknown', query: 'yoga' })
  })
})
