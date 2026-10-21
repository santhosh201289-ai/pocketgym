// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Groups, the member's side: an invitation says what joining shares, and a routine from the coach
// reaches the plan only on Accept — applied locally first, then the answer recorded.
const mocks = vi.hoisted(() => ({ api: null, S: null, toast: null, user: { id: 'm1', name: 'Asha' } }))
vi.mock('../lib/api.js', () => ({ api: (...a) => mocks.api(...a) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ S: mocks.S, user: mocks.user, update: fn => fn(mocks.S) })
  const useStore = sel => (sel ? sel(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast, openSheet: vi.fn() })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))

const { default: Groups } = await import('./Groups.jsx')

const ASSIGNMENT = {
  id: 'a1', group: 'g', groupName: 'Morning batch', coach: 'Coach Ravi', coachId: 'co', at: 1, note: 'Start light',
  plan: { pocketgym_plan: 1, unit: 'kg', week: {}, customEx: [], routines: [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8 }] }] },
  weekly: [2], dates: [],
}

let host, root, inbox
beforeEach(() => {
  mocks.S = { unit: 'kg', routines: [{ id: 'mine', name: 'Leg Day', ex: [{ id: '0043', sets: 3, reps: 5 }] }], customEx: [], week: { 2: ['mine'] }, dayPlan: {} }
  mocks.toast = vi.fn()
  inbox = { invites: [{ group: 'g2', name: 'Evening crew', coach: 'Coach Meera', at: 1 }], assignments: [ASSIGNMENT] }
  mocks.api = vi.fn(async (path, opts = {}) => {
    if (path === '/api/groups') return { coach: false, coaching: [], memberOf: [{ id: 'g', name: 'Morning batch', coach: 'Coach Ravi', status: 'active' }], pending: 1 }
    if (path === '/api/groups/inbox') return inbox
    if (path === '/api/groups/inbox/answer') { inbox = { ...inbox, assignments: [] }; return {} }
    return {}
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const mount = async () => {
  await act(async () => { root.render(<Groups />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text)

describe('Groups — the member', () => {
  it('says what joining shares, and what a routine would replace', async () => {
    await mount()
    expect(host.textContent).toContain('Coach Meera invited you to Evening crew')
    expect(host.textContent).toMatch(/sees your workouts, activity .* and body weight/)
    expect(host.textContent).toContain('Push Day')
    expect(host.textContent).toContain('Replaces Leg Day on Tuesday.')
    expect(mocks.S.routines).toHaveLength(1)
  })

  it('accepting applies it to the plan, then records the answer', async () => {
    await mount()
    await act(async () => { button('Accept').click() })
    expect(mocks.S.routines.map(r => r.name)).toEqual(['Leg Day', 'Push Day'])
    expect(mocks.S.week[2]).toEqual([mocks.S.routines[1].id])
    expect(mocks.api).toHaveBeenCalledWith('/api/groups/inbox/answer', { method: 'POST', body: JSON.stringify({ id: 'a1', accept: true }) })
    expect(mocks.toast).toHaveBeenCalledWith('Push Day added to your plan')
  })

  it('declining changes nothing in the plan', async () => {
    await mount()
    const decline = [...host.querySelectorAll('button')].filter(b => b.textContent === 'Decline')[1]
    await act(async () => { decline.click() })
    expect(mocks.S.routines).toHaveLength(1)
    expect(mocks.api).toHaveBeenCalledWith('/api/groups/inbox/answer', { method: 'POST', body: JSON.stringify({ id: 'a1', accept: false }) })
  })
})
