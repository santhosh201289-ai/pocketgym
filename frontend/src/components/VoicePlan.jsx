// Plan → "Plan by voice": say (or type) "add a push workout on Tuesday", see what that will do,
// and only then change the plan. The words are read by lib/voice-plan.js; the microphone is
// lib/speech.js. A weekday alone is every week; today, tomorrow, "this Friday" and "next Monday"
// are that day only.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { DAYN, fmtDate, todayISO, exCount } from '../lib/format.js'
import { parseRequest, planRequest, applyPlan } from '../lib/voice-plan.js'
import { starterRoutine } from '../lib/starter.js'
import { activeProfile, profileEquipment } from '../lib/equipment.js'
import { listen, speechSupported } from '../lib/speech.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

export const voicePlanSheet = () => useUI.getState().openSheet(close => <VoicePlan close={close} />)

const EXAMPLES = () => [
  t('Add a push workout on Tuesday'),
  t('Legs every Monday and Thursday'),
  t('Pull day tomorrow'),
  t('Rest on Sunday'),
]

const WHY = {
  empty: () => t('Nothing was heard. Try again, or type it.'),
  'no-day': () => t('Which day? For example "push on Tuesday" or "push tomorrow".'),
  'no-workout': () => t('Which workout? Name a routine, or push, pull, legs, upper, lower or full body.'),
  unknown: q => t('No routine called "{0}", and no starter one of that kind. Name one of your routines, or push, pull, legs, upper, lower or full body.', q),
}
const LISTEN_WHY = {
  permission: () => t('The microphone is not allowed. Allow it in the phone’s settings, or type instead.'),
  'no-speech': () => t('Nothing was heard. Try again, or type it.'),
  unsupported: () => t('Speech isn’t available here. Type it instead.'),
}

/** The best reading of what was said: the first alternative that makes a plan, else the first. */
export function readAlternatives(S, said, today = todayISO()) {
  let first = null
  for (const text of said) {
    const plan = planRequest(S, parseRequest(text, today))
    if (plan.ok) return { text, plan }
    first = first || { text, plan }
  }
  return first
}

function VoicePlan({ close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const [canListen, setCanListen] = useState(false)
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [typed, setTyped] = useState('')
  const [read, setRead] = useState(null)
  const [error, setError] = useState(null)
  const session = useRef(null)
  useEffect(() => {
    speechSupported().then(setCanListen).catch(() => {})
    return () => session.current?.stop()
  }, [])

  const understand = said => {
    const r = readAlternatives(useStore.getState().S, said.filter(Boolean))
    setHeard(r?.text || '')
    if (!r) { setRead(null); setError(WHY.empty()); return }
    setRead(r.plan.ok ? r.plan : null)
    setError(r.plan.ok ? null : (WHY[r.plan.reason] || WHY.empty)(r.plan.query))
  }
  const mic = async () => {
    if (listening) { session.current?.stop(); return }
    setError(null); setRead(null); setHeard('')
    setListening(true)
    const s = listen({ onPartial: setHeard })
    session.current = s
    try { understand(await s.result) }
    catch (e) { setError((LISTEN_WHY[e.code] || (() => t('Speech didn’t work this time. Try again, or type it.')))()) }
    finally { setListening(false); session.current = null }
  }

  const routineName = read?.routine?.name || (read?.make && starterRoutine(read.make)?.name)
  const days = read ? [
    ...read.weekly.map(d => t('Every {0}', t(DAYN[d]))),
    ...read.dates.map(iso => fmtDate(iso)),
  ] : []
  const go = combine => {
    const equipment = activeProfile(S) ? profileEquipment(activeProfile(S)) : undefined
    const routine = read.routine || (read.make ? starterRoutine(read.make, equipment) : null)
    if (!read.rest && !routine) { setError(WHY.unknown(read.make)); return }
    update(s => applyPlan(s, read, { routine, combine }))
    toast(read.rest ? t('Rest day set: {0}', days.join(', ')) : t('{0} planned: {1}', routine.name, days.join(', ')))
    close()
  }

  return <>
    <h3>{t('Plan by voice')}</h3>
    <div className="small muted" style={{ lineHeight: 1.5, marginBottom: 12 }}>
      {t('Say which workout and which day. A weekday on its own repeats every week; today, tomorrow, “this Friday” or “next Monday” is that day only.')}
    </div>

    {canListen && <div style={{ textAlign: 'center', margin: '8px 0 14px' }}>
      <button className={'voice-mic' + (listening ? ' on' : '')} onClick={mic} aria-label={listening ? t('Stop listening') : t('Start listening')}>
        <Icon name="mic" />
      </button>
      <div className="small muted" style={{ marginTop: 8, minHeight: 20 }}>{listening ? (heard || t('Listening…')) : heard ? `“${heard}”` : t('Tap and speak')}</div>
    </div>}

    <form className="row" style={{ gap: 8 }} onSubmit={e => { e.preventDefault(); if (typed.trim()) understand([typed.trim()]) }}>
      <input className="input" style={{ flex: 1 }} value={typed} onChange={e => setTyped(e.target.value)}
        placeholder={canListen ? t('…or type it') : t('Type it, e.g. push on Tuesday')} aria-label={t('What to plan')} />
      <Button size="sm" type="submit" disabled={!typed.trim()}>{t('Go')}</Button>
    </form>

    {error && <div className="small" style={{ color: 'var(--orange)', marginTop: 12, lineHeight: 1.5 }}>{error}</div>}

    {read && <div className="card" style={{ marginTop: 14, padding: 14 }}>
      <div className="tt" style={{ fontWeight: 600 }}>{read.rest ? t('Rest') : routineName}</div>
      <div className="small muted" style={{ marginTop: 2 }}>{days.join(' · ')}</div>
      {read.make && !read.routine && (() => { const r = starterRoutine(read.make); return r && <div className="small" style={{ marginTop: 8 }}>{t('Not in your routines yet: a starter {0} ({1}) will be added, fitted to your equipment.', r.name, exCount(r.ex.length))}</div> })()}
      {read.busy.length > 0 && <div className="small" style={{ marginTop: 8 }}>
        {read.busy.map(b => t('{0} already has {1}.', t(DAYN[b.day]), b.names.join(' + '))).join(' ')}
      </div>}
      <div style={{ height: 12 }} />
      {read.busy.length > 0
        ? <>
          <Button variant="primary" onClick={() => go(false)}>{t('Replace')}</Button>
          <div style={{ height: 8 }} />
          <Button onClick={() => go(true)}>{t('Train both that day')}</Button>
        </>
        : <Button variant="primary" onClick={() => go(false)}>{t('Add to plan')}</Button>}
    </div>}

    {!read && <div className="small dim" style={{ marginTop: 14, lineHeight: 1.7 }}>
      {t('Try:')} {EXAMPLES().map(x => `“${x}”`).join(' · ')}
    </div>}
  </>
}
