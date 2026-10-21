// Settings → Data & backup → Send activity from iPhone. An iPhone has no Health Connect, and
// Apple Health is open only to a native app with its own entitlement, so the phone sends its own
// numbers instead: an iOS Shortcut (or Health Auto Export) posts them to
// POST /api/ingest/activity with this profile's ingest token (api/ingest.js). The token is shown
// once, when it is made; the server keeps only its hash.
import { useEffect, useState } from 'react'
import { api, serverBase } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { t } from '../lib/i18n.js'
import { useUI } from '../store/useUI.js'
import { Section, Row, Button } from './ui.jsx'

export const INGEST_PATH = '/api/ingest/activity'

const when = ms => (ms ? new Date(ms).toLocaleString() : '')

/** The card: whether a token is set up, and the sheet that sets one up. */
export function IngestCard() {
  const [info, setInfo] = useState(null)
  const reload = () => api('/api/ingest/token').then(setInfo).catch(() => setInfo({ on: false, error: true }))
  useEffect(() => { reload() }, [])
  const open = () => useUI.getState().openSheet(() => <IngestSheet onChange={setInfo} />)
  return (
    <Section title={t('iPhone and Apple Watch')}
      footer={t('Or import an Apple Health export once with Import activity below.')}>
      <Row icon="figureRun" iconTint="var(--orange)" title={t('Send activity from iPhone')}
        subtitle={info?.on
          ? (info.used ? t('Set up · last received {0}', when(info.used)) : t('Set up · nothing received yet'))
          : t('Steps, sleep, heart rate and workouts from Apple Health, sent by a Shortcut every day')}
        accessory="chevron" onClick={open} />
    </Section>
  )
}

function Copyable({ label, value }) {
  const toast = useUI(s => s.toast)
  return (
    <div style={{ margin: '10px 0' }}>
      <div className="small muted" style={{ marginBottom: 4 }}>{label}</div>
      <div className="row between" style={{ gap: 8, alignItems: 'center' }}>
        <code className="small" style={{ wordBreak: 'break-all', flex: 1, padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)' }}>{value}</code>
        <Button size="sm" onClick={async () => toast((await copyText(value)) ? t('Copied') : t("Couldn't copy"))}>{t('Copy')}</Button>
      </div>
    </div>
  )
}

export function IngestSheet({ onChange }) {
  const [info, setInfo] = useState(null)
  const [token, setToken] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [replacing, setReplacing] = useState(false)
  const url = serverBase() + INGEST_PATH
  const show = v => { setInfo(v); onChange?.(v) }
  useEffect(() => { api('/api/ingest/token').then(show).catch(e => setError(e.message)) }, [])

  const make = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api('/api/ingest/token', { method: 'POST' })
      setToken(r.token); setReplacing(false)
      show({ on: true, at: r.at, used: null })
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const turnOff = async () => {
    setBusy(true); setError(null)
    try { await api('/api/ingest/token', { method: 'DELETE' }); setToken(null); show({ on: false }) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return <>
    <h3>{t('Send activity from iPhone')}</h3>
    <div className="small muted" style={{ lineHeight: 1.5 }}>
      {t('A Shortcut on your iPhone reads today’s steps, distance, active energy, resting heart rate and sleep from Apple Health and sends them here. Run it on a schedule and Pocket Gym stays up to date on every device.')}
    </div>
    {error && <div className="small" style={{ color: 'var(--red)', marginTop: 10 }}>{error}</div>}
    {!info ? null : !info.on ? <>
      <div style={{ height: 14 }} />
      <Button variant="primary" disabled={busy} onClick={make}>{t('Create a token')}</Button>
    </> : <>
      <Copyable label={t('Address (URL)')} value={url} />
      {token
        ? <>
          <Copyable label={t('Header Authorization')} value={'Bearer ' + token} />
          <div className="small" style={{ color: 'var(--orange)' }}>{t('Copy it now: the token is shown only this once. It can add activity to your profile and do nothing else.')}</div>
        </>
        : <div className="small muted" style={{ margin: '6px 0' }}>
          {t('Token made {0}.', when(info.at))} {info.used ? t('Last received {0}.', when(info.used)) : t('Nothing received yet.')} {t('Lost it? Make a new one; the old one stops working.')}
        </div>}
      <h4 style={{ margin: '16px 0 6px' }}>{t('Set up the Shortcut')}</h4>
      <ol className="small" style={{ paddingInlineStart: 20, lineHeight: 1.6, margin: 0 }}>
        <li>{t('Shortcuts app → + → name it "Pocket Gym".')}</li>
        <li>{t('Add "Find Health Samples": Type Steps, Start Date is Today. Then "Calculate Statistics": Sum. Repeat for Walking + Running Distance (in km) and Active Energy (in kcal).')}</li>
        <li>{t('Optional: "Find Health Samples" for Resting Heart Rate, sorted by Start Date, latest first, limit 1.')}</li>
        <li>{t('Add "Format Date": Current Date, custom format yyyy-MM-dd.')}</li>
        <li>{t('Add "Get Contents of URL" with the address above. Method POST, header Authorization with the value above, Request Body JSON with the fields date, steps, distanceKm, activeKcal and restingHr, each set to its result.')}</li>
        <li>{t('Automation → + → Time of Day, for example 22:00 daily → Run Immediately → Run Shortcut "Pocket Gym". Run it a few times a day if you like; the same numbers are never counted twice.')}</li>
      </ol>
      <div className="small dim" style={{ marginTop: 10, lineHeight: 1.5 }}>
        {t('Health Auto Export works too: add a REST API automation with the same address and header, format JSON, and pick Steps, Walking + Running Distance, Active Energy, Resting Heart Rate, Sleep and Workouts.')}
      </div>
      <div style={{ height: 14 }} />
      {replacing
        ? <>
          <div className="small muted" style={{ marginBottom: 8 }}>{t('A Shortcut set up with the old token will stop working until you paste the new one.')}</div>
          <Button variant="primary" disabled={busy} onClick={make}>{t('Make a new token')}</Button>
          <Button variant="ghost" onClick={() => setReplacing(false)}>{t('Cancel')}</Button>
        </>
        : <>
          <Button disabled={busy} onClick={() => setReplacing(true)}>{t('Make a new token')}</Button>
          <Button variant="ghost" className="dim" disabled={busy} onClick={turnOff}>{t('Turn off')}</Button>
        </>}
    </>}
  </>
}
