// Settings → Data & backup → Strava. The server holds the connection and does the fetching
// (api/strava.js); this card starts the OAuth flow, says how the last sync went, and can sync
// now or disconnect. Runs, rides, walks, swims and hikes arrive as sessions, merged like every
// other import, and reach this device through the normal sync.
import { useEffect, useState } from 'react'
import { api, appBase, serverBase } from '../lib/api.js'
import { MOBILE } from '../lib/mobile.js'
import { t } from '../lib/i18n.js'
import { useUI } from '../store/useUI.js'
import { Section, Row } from './ui.jsx'

const STRAVA_ORANGE = '#FC4C02'
const when = ms => (ms ? new Date(ms).toLocaleString() : '')

// What the server's redirect back from Strava says (`#/settings/data?strava=…`).
const OUTCOME = {
  connected: () => t('Strava connected. Your activities are on their way.'),
  denied: () => t('Strava was not connected.'),
  scope: () => t('Strava was connected without access to activities. Connect again and leave "View data about your activities" ticked.'),
  expired: () => t('That Strava link expired. Tap Connect with Strava again.'),
  failed: () => t("Strava didn't accept the connection. Try again in a moment."),
}
function outcomeOnce() {
  try {
    const m = /[?&]strava=([a-z]+)/.exec(window.location.hash || '')
    if (!m) return null
    window.history.replaceState(null, '', window.location.href.replace(/[?&]strava=[a-z]+/, ''))
    return OUTCOME[m[1]] ? OUTCOME[m[1]]() : null
  } catch { return null }
}

export function startStravaConnect() {
  // The web app is signed in right here. The phone's WebView has no cookie for the server, so the
  // flow runs in the system browser, signed in to the same server.
  if (MOBILE) window.open(serverBase() + '/api/strava/connect', '_blank', 'noopener')
  else window.location.href = appBase().replace(/\/$/, '') + '/api/strava/connect'
}

export function StravaCard() {
  const toast = useUI(s => s.toast)
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => api('/api/strava/status').then(setSt).catch(() => setSt(null))
  useEffect(() => {
    const said = outcomeOnce()
    if (said) toast(said)
    load()
  }, [])
  // The first year comes in behind the redirect: look again while it runs.
  useEffect(() => {
    if (!st?.syncing) return
    const id = setTimeout(load, 3000)
    return () => clearTimeout(id)
  }, [st])
  if (!st) return null

  const footer = t('Runs, rides, walks, swims and hikes from Strava, including what Garmin, COROS, Polar, Suunto and Wahoo upload there. New ones arrive within about half an hour while Pocket Gym is open.')
  if (!st.available) return (
    <Section title={t('Strava')}>
      <Row icon="figureRun" iconTint={STRAVA_ORANGE} title={t('Strava')}
        subtitle={t('Not set up on this server. The server admin adds a Strava API application (STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET).')} />
    </Section>
  )
  if (!st.connected) return (
    <Section title={t('Strava')} footer={footer}>
      <Row icon="figureRun" iconTint={STRAVA_ORANGE} title={t('Strava')}
        subtitle={MOBILE ? t('Connect with Strava. Opens your browser; sign in to Pocket Gym there if it asks.') : t('Connect with Strava')}
        accessory="chevron" onClick={startStravaConnect} />
    </Section>
  )

  const syncNow = async () => {
    setBusy(true)
    try {
      const r = await api('/api/strava/sync', { method: 'POST', body: '{}' })
      setSt(r)
      toast(r.sessions ? t('{0} new from Strava', r.sessions) : t('Nothing new on Strava'))
    } catch (e) {
      if (e.data?.connected != null) setSt(e.data)
      toast(e.message)
    } finally { setBusy(false) }
  }
  const disconnect = async () => {
    setBusy(true)
    try { await api('/api/strava', { method: 'DELETE' }); setSt({ available: true, connected: false }); toast(t('Strava disconnected. What it brought in stays.')) }
    catch (e) { toast(e.message) } finally { setBusy(false) }
  }
  const status = st.syncing ? t('Syncing…')
    : st.error ? t('Last try {0}: {1}', when(st.syncedAt), st.error)
    : st.syncedAt ? t('Synced {0} · {1} sessions so far', when(st.syncedAt), st.count || 0)
    : t('Connected')
  return (
    <Section title={t('Strava')} footer={footer}>
      <Row icon="figureRun" iconTint={STRAVA_ORANGE} title={t('Strava')}
        subtitle={(st.athlete ? st.athlete + ' · ' : '') + status} />
      <Row icon="reset" iconTint="var(--acc)" title={t('Sync Strava now')} accessory="chevron"
        onClick={busy || st.syncing ? undefined : syncNow} />
      <Row icon="signOut" iconTint="var(--red)" title={t('Disconnect Strava')} danger
        onClick={busy ? undefined : disconnect} />
    </Section>
  )
}
