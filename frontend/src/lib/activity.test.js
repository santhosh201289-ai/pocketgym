import { describe, it, expect } from 'vitest'
import { mergeDays, addSessions, cleanSession, fmtDist, fmtPace, fmtDur, lastDays, totalsByType } from './activity.js'
import { mergeStates } from './sync-merge.js'

describe('mergeDays', () => {
  it('keeps fields from each source and stamps changed days', () => {
    let { activity } = mergeDays([], [{ d: '2026-10-16', steps: 8000 }], 'Health Connect', 100)
    ;({ activity } = mergeDays(activity, [{ d: '2026-10-16', sleepMin: 420 }], 'Apple Health', 200))
    expect(activity).toEqual([{ d: '2026-10-16', steps: 8000, sleepMin: 420, src: 'Apple Health', t: 200 }])
  })
  it('leaves an unchanged day alone', () => {
    const cur = [{ d: '2026-10-16', steps: 8000, src: 'x', t: 1 }]
    const r = mergeDays(cur, [{ d: '2026-10-16', steps: 8000 }], 'y', 9)
    expect(r.changed).toBe(0)
    expect(r.activity[0].t).toBe(1)
  })
  it('ignores bad days and negative values', () => {
    expect(mergeDays([], [{ d: 'nope', steps: 1 }, { d: '2026-10-16', steps: -5 }], 'x').changed).toBe(0)
  })
})

describe('addSessions', () => {
  const run = { type: 'run', start: Date.UTC(2026, 9, 16, 1, 0), durS: 1800, distM: 5000, src: 'FIT', srcId: '1' }
  it('adds a session once, however often it is imported', () => {
    let { sessions, added } = addSessions([], [run], 'FIT', 10)
    expect(added).toBe(1)
    ;({ sessions, added } = addSessions(sessions, [run], 'FIT', 20))
    expect(added).toBe(0)
    expect(sessions).toHaveLength(1)
  })
  it('treats the same run from another source as the same session', () => {
    const { sessions } = addSessions([], [run], 'FIT', 10)
    const fromStrava = { ...run, start: run.start + 60000, src: 'strava', srcId: '999' }
    expect(addSessions(sessions, [fromStrava], 'strava').added).toBe(0)
  })
  it('rejects a session with no start or duration', () => {
    expect(cleanSession({ type: 'run' })).toBeNull()
  })
})

describe('formatting', () => {
  it('shows distance in km or miles, swims in metres or yards', () => {
    expect(fmtDist(5100, { speedUnit: 'kmh' })).toBe('5.10 km')
    expect(fmtDist(1609.344 * 3, { speedUnit: 'mph' })).toBe('3.00 mi')
    expect(fmtDist(1500, {}, 'swim')).toBe('1500 m')
  })
  it('shows pace per km, per 100 m for swims, speed for rides', () => {
    expect(fmtPace({ type: 'run', distM: 5000, durS: 1500 }, {})).toBe('5:00 /km')
    expect(fmtPace({ type: 'swim', distM: 1000, durS: 1200 }, {})).toBe('2:00 /100m')
    expect(fmtPace({ type: 'ride', distM: 30000, durS: 3600 }, {})).toBe('30.0 km/h')
    expect(fmtDur(3930)).toBe('1:05:30')
  })
})

describe('reading', () => {
  it('lists the last days with gaps filled and totals sessions by kind', () => {
    const S = { activity: [{ d: '2026-10-16', steps: 5 }] }
    const days = lastDays(S, 3, '2026-10-17')
    expect(days.map(x => x.d)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17'])
    expect(days[1].steps).toBe(5)
    expect(totalsByType([{ type: 'run', distM: 5000, durS: 1500 }, { type: 'run', distM: 3000, durS: 900 }]).run).toEqual({ n: 2, distM: 8000, durS: 2400 })
  })
})

describe('sync across devices', () => {
  it('unites sessions by id and keeps each day\'s latest record', () => {
    const a = { _ts: 2, workouts: [], sessions: [{ id: 'as1', type: 'run', start: 1, durS: 60, _ts: 1 }], activity: [{ d: '2026-10-16', steps: 100, t: 5 }] }
    const b = { _ts: 1, workouts: [], sessions: [{ id: 'as2', type: 'swim', start: 2, durS: 60, _ts: 1 }], activity: [{ d: '2026-10-16', steps: 900, t: 9 }, { d: '2026-10-15', steps: 3, t: 1 }] }
    const m = mergeStates(a, b)
    expect(m.sessions.map(s => s.id).sort()).toEqual(['as1', 'as2'])
    expect(m.activity).toEqual([{ d: '2026-10-15', steps: 3, t: 1 }, { d: '2026-10-16', steps: 900, t: 9 }])
  })
  it('keeps a session deleted on one device deleted', () => {
    const a = { _ts: 2, workouts: [], sessions: [], deleted: { sessions: { as1: 50 } } }
    const b = { _ts: 1, workouts: [], sessions: [{ id: 'as1', type: 'run', start: 1, durS: 60, _ts: 10 }] }
    expect(mergeStates(a, b).sessions).toEqual([])
  })
})
