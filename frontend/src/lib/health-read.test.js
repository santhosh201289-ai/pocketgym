import { describe, it, expect } from 'vitest'
import { sleepByDay, fromHealthConnect, appName } from './health-read.js'

const at = (d, h, m = 0) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).getTime()

describe('sleepByDay', () => {
  it('puts a night on the morning it ends and leaves out time awake', () => {
    const r = sleepByDay([{ start: at('2026-10-15', 23), end: at('2026-10-16', 7), awakeMs: 30 * 60000, origin: 'band' }])
    expect(r).toEqual([{ d: '2026-10-16', sleepMin: 450 }])
  })
  it('takes the app that tracked the most, not the sum of two apps tracking one night', () => {
    const r = sleepByDay([
      { start: at('2026-10-15', 23), end: at('2026-10-16', 6), origin: 'band' },
      { start: at('2026-10-15', 23, 30), end: at('2026-10-16', 6), origin: 'phone' },
    ])
    expect(r[0].sleepMin).toBe(420)
  })
  it('adds a nap from the same app to its night', () => {
    const r = sleepByDay([
      { start: at('2026-10-16', 1), end: at('2026-10-16', 6), origin: 'band' },
      { start: at('2026-10-16', 13), end: at('2026-10-16', 14), origin: 'band' },
    ])
    expect(r[0].sleepMin).toBe(360)
  })
})

describe('fromHealthConnect', () => {
  it('turns daily totals, sleep and sessions into activity', () => {
    const r = fromHealthConnect({
      days: [{ d: '2026-10-16', steps: 9000, distM: 6500.4, activeKcal: 410.2, restHr: 58 }],
      sleep: [{ start: at('2026-10-15', 23), end: at('2026-10-16', 6), awakeMs: 0, origin: 'com.noisefit' }],
      sessions: [{ id: 'hc-1', type: 'swim', start: at('2026-10-16', 7), end: at('2026-10-16', 7, 40), origin: 'com.garmin.android.apps.connectmobile', distM: 1500, laps: 60, avgHr: 130 }],
    })
    expect(r.days).toEqual([{ d: '2026-10-16', steps: 9000, distM: 6500.4, activeKcal: 410.2, restHr: 58, sleepMin: 420 }])
    expect(r.sessions[0]).toMatchObject({ type: 'swim', durS: 2400, distM: 1500, laps: 60, avgHr: 130, src: 'Garmin Connect', srcId: 'hc-1' })
  })
  it('names apps people know, and passes an unknown package through', () => {
    expect(appName('com.strava')).toBe('Strava')
    expect(appName('com.example.band')).toBe('com.example.band')
  })
  it('copes with an empty or missing answer', () => {
    expect(fromHealthConnect(null)).toEqual({ days: [], sessions: [] })
  })
})
