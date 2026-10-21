// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StravaCard } from './StravaCard.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The Strava card: says when the server has no Strava, offers to connect, and once connected
// shows the last sync and can sync now or disconnect. lib/api.js is mocked.
const mocks = vi.hoisted(() => ({ api: null, status: null, toast: null }))
vi.mock('../lib/api.js', () => ({ api: (...a) => mocks.api(...a), appBase: () => '/', serverBase: () => 'https://gym.example' }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false }))
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

let host, root
beforeEach(() => {
  mocks.toast = vi.fn()
  mocks.api = vi.fn(async (path, opts = {}) => {
    if (path === '/api/strava/status') return mocks.status
    if (path === '/api/strava/sync') return { ...mocks.status, ok: true, sessions: 3 }
    if (path === '/api/strava' && opts.method === 'DELETE') return { ok: true }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const mount = async () => {
  await act(async () => { root.render(<StravaCard />) })
  await act(async () => { await Promise.resolve() })
}
const row = text => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes(text))

describe('StravaCard', () => {
  it('says so when the server has no Strava', async () => {
    mocks.status = { available: false, connected: false }
    await mount()
    expect(row('Not set up on this server')).toBeTruthy()
    expect(row('Sync Strava now')).toBeUndefined()
  })

  it('syncs and disconnects once connected', async () => {
    mocks.status = { available: true, connected: true, athlete: 'Asha K', syncedAt: 1, count: 5, error: null }
    await mount()
    expect(row('Asha K')).toBeTruthy()
    await act(async () => { row('Sync Strava now').click() })
    expect(mocks.api).toHaveBeenCalledWith('/api/strava/sync', { method: 'POST', body: '{}' })
    expect(mocks.toast).toHaveBeenCalledWith('3 new from Strava')
    await act(async () => { row('Disconnect Strava').click() })
    expect(mocks.api).toHaveBeenCalledWith('/api/strava', { method: 'DELETE' })
    expect(row('Connect with Strava')).toBeTruthy()
  })

  it('tells what the redirect back from Strava said, once', async () => {
    window.location.hash = '#/settings/data?strava=scope'
    mocks.status = { available: true, connected: false }
    await mount()
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast.mock.calls[0][0]).toMatch(/without access to activities/)
    expect(window.location.hash).toBe('#/settings/data')
  })
})
