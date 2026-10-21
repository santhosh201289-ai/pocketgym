import { describe, expect, it } from 'vitest'
import { acceptAssignment, assignmentClashes, readAssignment } from './group-assign.js'

const assignment = (over = {}) => ({
  id: 'a1', coachId: 'co', coach: 'Coach Ravi', groupName: 'Morning batch', at: 5,
  plan: { pocketgym_plan: 1, unit: 'kg', week: {}, customEx: [], routines: [{ id: 'r1', name: 'Push Day', emoji: 'barbell', ex: [{ id: '0025', sets: 3, reps: 8, weight: 40 }] }] },
  weekly: [2], dates: [],
  ...over,
})
const state = () => ({ unit: 'kg', routines: [{ id: 'mine', name: 'Leg Day', ex: [{ id: '0043', sets: 3, reps: 5 }] }], customEx: [], week: { 2: ['mine'], 4: ['mine'] }, dayPlan: {} })

describe('acceptAssignment', () => {
  it('adds the routine, marked as the coach’s, and puts it on the days chosen', () => {
    const s = state()
    const r = acceptAssignment(s, assignment({ dates: ['2026-10-30'] }))
    expect(s.routines).toHaveLength(2)
    expect(r.name).toBe('Push Day')
    expect(r.fromCoach).toEqual({ key: 'co:r1', coach: 'Coach Ravi', group: 'Morning batch', at: 5 })
    expect(s.week[2]).toEqual([r.id])
    expect(s.week[4]).toEqual(['mine'])
    expect(s.dayPlan['2026-10-30']).toBe(r.id)
  })

  it('sent again, it updates the routine it made, not a second copy', () => {
    const s = state()
    const first = acceptAssignment(s, assignment())
    const again = acceptAssignment(s, assignment({ weekly: [5], plan: { ...assignment().plan, routines: [{ id: 'r1', name: 'Push Day v2', ex: [{ id: '0025', sets: 5, reps: 5 }] }] } }))
    expect(again.id).toBe(first.id)
    expect(s.routines).toHaveLength(2)
    expect(again.name).toBe('Push Day v2')
    expect(again.ex[0].sets).toBe(5)
    expect(s.week[5]).toEqual([first.id])
  })

  it('converts weights into the member’s unit', () => {
    const s = { ...state(), unit: 'lb' }
    const r = acceptAssignment(s, assignment())
    expect(r.ex[0].weight).toBeGreaterThan(80)
  })

  it('refuses a routine with nothing this app knows', () => {
    expect(() => readAssignment(assignment({ plan: { ...assignment().plan, routines: [{ id: 'r1', name: 'X', ex: [{ id: 'nope', sets: 3 }] }] } }))).toThrow()
    expect(() => readAssignment({ plan: null })).toThrow()
  })

  it('says which days it would take over', () => {
    expect(assignmentClashes(state(), assignment({ weekly: [2, 3] }))).toEqual([{ day: 2, names: ['Leg Day'] }])
  })
})
