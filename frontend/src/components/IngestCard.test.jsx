// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IngestSheet, INGEST_PATH } from './IngestCard.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The sheet that sets up "Send activity from iPhone": makes the token, shows it once with the
// address to send to, and can replace or retire it. lib/api.js is mocked.
const mocks = vi.hoisted(() => ({ api: null, server: { on: false } }))
vi.mock('../lib/api.js', () => ({ api: (...a) => mocks.api(...a), serverBase: () => 'https://gym.example' }))
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

let host, root
beforeEach(() => {
  mocks.server = { on: false }
  mocks.api = vi.fn(async (path, opts = {}) => {
    const m = opts.method || 'GET'
    if (m === 'GET') return mocks.server
    if (m === 'POST') { mocks.server = { on: true, at: 1 }; return { token: 'pgi_secret', at: 1 } }
    if (m === 'DELETE') { mocks.server = { on: false }; return { ok: true } }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const mount = async onChange => {
  await act(async () => { root.render(<IngestSheet onChange={onChange} />) })
  await act(async () => { await Promise.resolve() })
}
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text)

describe('IngestSheet', () => {
  it('makes a token and shows it once, with the address', async () => {
    const onChange = vi.fn()
    await mount(onChange)
    expect(host.textContent).not.toContain(INGEST_PATH)
    await act(async () => { button('Create a token').click() })
    expect(mocks.api).toHaveBeenCalledWith('/api/ingest/token', { method: 'POST' })
    expect(host.textContent).toContain('https://gym.example' + INGEST_PATH)
    expect(host.textContent).toContain('Bearer pgi_secret')
    expect(onChange).toHaveBeenLastCalledWith({ on: true, at: 1, used: null })
  })

  it('never shows a token it did not just make, and can retire it', async () => {
    mocks.server = { on: true, at: 1, used: 2 }
    await mount()
    expect(host.textContent).toContain(INGEST_PATH)
    expect(host.textContent).not.toContain('Bearer')
    // Replacing asks first.
    await act(async () => { button('Make a new token').click() })
    expect(mocks.api).not.toHaveBeenCalledWith('/api/ingest/token', { method: 'POST' })
    await act(async () => { button('Cancel').click() })
    await act(async () => { button('Turn off').click() })
    expect(mocks.api).toHaveBeenCalledWith('/api/ingest/token', { method: 'DELETE' })
    expect(button('Create a token')).toBeTruthy()
  })
})
