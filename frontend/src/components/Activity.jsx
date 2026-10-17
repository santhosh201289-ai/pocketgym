// Activity on screen: the Home card, the Stats section, and the sheets that add, edit and import
// it. The data and its rules live in lib/activity.js; files are read by lib/import-activity.js.
import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, tn } from '../lib/i18n.js'
import { fmtDate, fmtNum, todayISO, isoOf } from '../lib/format.js'
import {
  SESSION_TYPES, sessionLabel, mergeDays, addSessions, cleanSession, dayOf, lastDays, sessionsSince,
  totalsByType, avgOf, fmtDist, fmtDur, fmtPace, fmtSleep, distUnitOf,
} from '../lib/activity.js'
import { parseActivityFiles } from '../lib/import-activity.js'
import LineChart from './LineChart.jsx'
import Icon from './Icon.jsx'
import { Button, NumberField, Segmented, SelectRow, TextField } from './ui.jsx'

const update = (...a) => useStore.getState().update(...a)
const ui = () => useUI.getState()
const toast = m => ui().toast(m)

const TYPE_ICON = { run: 'figureRun', walk: 'figureRun', ride: 'bike', swim: 'swim', hike: 'figureRun', other: 'flame' }
const TYPE_TINT = { run: 'var(--orange)', walk: 'var(--teal)', ride: 'var(--blue)', swim: 'var(--blue)', hike: 'var(--green)', other: 'var(--purple)' }

/* ============================================================= small pieces ============= */

/** One bar per day; the goal as a dashed line. Values are the day's field, gaps as 0. */
function DayBars({ days, field, goal, h = 110, color = 'var(--acc)', label }) {
  const vals = days.map(d => d[field] || 0)
  const max = Math.max(goal || 0, ...vals, 1)
  const w = 100 / days.length
  return <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" width="100%" height={h} role="img"
    aria-label={label} style={{ display: 'block', width: '100%', height: h }}>
    {vals.map((v, i) => v > 0 && <rect key={days[i].d} x={i * w + w * 0.15} width={w * 0.7}
      y={h - (v / max) * (h - 4)} height={(v / max) * (h - 4)} rx={Math.min(1.2, w * 0.2)}
      fill={color} opacity={!goal || v >= goal ? 1 : 0.4} />)}
    {goal > 0 && <line x1="0" x2="100" y1={h - (goal / max) * (h - 4)} y2={h - (goal / max) * (h - 4)}
      stroke="var(--yellow)" strokeWidth="0.6" strokeDasharray="2 1.5" vectorEffect="non-scaling-stroke" />}
  </svg>
}

function Stat({ icon, tint, value, label }) {
  return <div style={{ flex: 1, minWidth: 0 }}>
    <div className="row" style={{ gap: 5, color: tint, fontSize: 13 }}><Icon name={icon} /><span className="dim small">{label}</span></div>
    <div style={{ fontWeight: 600, fontSize: '1.05rem', marginTop: 2 }}>{value || '–'}</div>
  </div>
}

function SessionRow({ s, S, onClick }) {
  const bits = [fmtDist(s.distM, S, s.type), fmtDur(s.durS), fmtPace(s, S), s.avgHr ? `${s.avgHr} bpm` : ''].filter(Boolean)
  return <button className="row tappable" onClick={onClick}
    style={{ width: '100%', gap: 10, padding: '9px 2px', borderBottom: '1px solid var(--sep)', textAlign: 'start', background: 'none', border: 0, borderBottomStyle: 'solid', color: 'inherit' }}>
    <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: TYPE_TINT[s.type], flex: 'none' }}>
      <Icon name={TYPE_ICON[s.type]} />
    </span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', fontWeight: 600 }}>{s.name || t(sessionLabel(s.type))}</span>
      <span className="small dim">{bits.join(' · ')}</span>
    </span>
    <span className="small dim" style={{ flex: 'none' }}>{fmtDate(s.d)}</span>
  </button>
}

/* ================================================================ Home card ============= */

export function ActivityCard() {
  const S = useStore(s => s.S)
  const today = dayOf(S, todayISO()) || {}
  const week = lastDays(S, 7)
  const latest = (S.sessions || [])[0]
  const goal = S.stepGoal || 0
  const steps = today.steps || 0
  const pct = goal ? Math.min(1, steps / goal) : 0
  const empty = !(S.activity || []).length && !(S.sessions || []).length
  return <div className="card">
    <div className="row between" style={{ marginBottom: 8 }}>
      <h2 style={{ margin: 0 }}>{t("Today's activity")}</h2>
      <div className="row" style={{ gap: 8 }}>
        <Button size="sm" icon="pencil" onClick={() => daySheet(todayISO())}>{t('Day')}</Button>
        <Button size="sm" icon="plus" onClick={() => sessionSheet()}>{t('Session')}</Button>
      </div>
    </div>
    {empty ? <div className="muted small">
      {t('Log a run, walk, ride or swim, or bring in steps, sleep and sessions from your phone, band or watch (Settings → Data & backup → Import activity).')}
    </div> : <>
      <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
        <div className="big">{fmtNum(steps)}</div>
        <span className="muted">{goal ? t('of {0} steps', fmtNum(goal)) : t('steps')}</span>
      </div>
      {goal > 0 && <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-2)', marginTop: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, height: '100%', background: pct >= 1 ? 'var(--green)' : 'var(--acc)', borderRadius: 3 }} />
      </div>}
      <div className="row" style={{ gap: 10, marginTop: 12 }}>
        <Stat icon="moon" tint="var(--purple)" label={t('Sleep')} value={fmtSleep(today.sleepMin)} />
        <Stat icon="heart" tint="var(--red)" label={t('Resting HR')} value={today.restHr ? `${today.restHr} bpm` : ''} />
        <Stat icon="flame" tint="var(--orange)" label={t('Active')} value={today.activeKcal ? `${fmtNum(today.activeKcal)} kcal` : ''} />
      </div>
      <div className="chart" style={{ marginTop: 12 }}><DayBars days={week} field="steps" goal={goal} h={60} label={t('Steps, last 7 days')} /></div>
      {latest && <div style={{ marginTop: 6 }}><SessionRow s={latest} S={S} onClick={() => sessionSheet(latest)} /></div>}
    </>}
  </div>
}

/* ============================================================== Stats section ============= */

const RANGES = { '1M': 30, '3M': 91, '1Y': 365 }

export function ActivityStats() {
  const S = useStore(s => s.S)
  const [range, setRange] = useState('1M')
  const nDays = RANGES[range]
  const days = useMemo(() => lastDays(S, nDays), [S.activity, nDays])
  const from = days[0].d
  const sessions = useMemo(() => sessionsSince(S, from), [S.sessions, from])
  const totals = totalsByType(sessions)
  const avgSteps = avgOf(days, 'steps')
  const pts = f => days.filter(d => d[f] > 0).map(d => ({ t: new Date(d.d + 'T12:00:00').getTime(), y: f === 'sleepMin' ? Math.round(d[f] / 6) / 10 : d[f], d: d.d }))
  const hr = pts('restHr'), sleep = pts('sleepMin')
  if (!(S.activity || []).length && !(S.sessions || []).length) return null
  return <div className="card">
    <div className="row between" style={{ marginBottom: 8 }}>
      <h2 style={{ margin: 0 }}>{t('Steps & cardio')}</h2>
      <Segmented options={Object.keys(RANGES).map(k => ({ value: k, label: k }))} value={range} onChange={setRange} />
    </div>
    {days.some(d => d.steps > 0) && <>
      <div className="row between small"><span className="dim">{t('Steps')}</span>
        {avgSteps && <span className="dim">{t('{0} a day on average', fmtNum(Math.round(avgSteps)))}</span>}</div>
      <div className="chart" style={{ marginTop: 6 }}><DayBars days={days} field="steps" goal={S.stepGoal} label={t('Steps per day')} /></div>
    </>}
    {Object.keys(totals).length > 0 && <>
      <div className="small dim" style={{ marginTop: 14 }}>{t('Sessions')}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {SESSION_TYPES.filter(k => totals[k]).map(k => <div key={k} className="mchip" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon name={TYPE_ICON[k]} style={{ color: TYPE_TINT[k] }} />
          <span>{t(sessionLabel(k))} · {totals[k].n}{totals[k].distM ? ' · ' + fmtDist(totals[k].distM, S, k) : ''} · {fmtDur(totals[k].durS)}</span>
        </div>)}
      </div>
    </>}
    {hr.length > 1 && <>
      <div className="small dim" style={{ marginTop: 14 }}>{t('Resting heart rate')}</div>
      <div className="chart"><LineChart points={hr} h={110} unit="bpm" color="var(--red)" /></div>
    </>}
    {sleep.length > 1 && <>
      <div className="small dim" style={{ marginTop: 14 }}>{t('Sleep')}</div>
      <div className="chart"><LineChart points={sleep} h={110} unit="h" color="var(--purple)" /></div>
    </>}
    {sessions.length > 0 && <>
      <div className="small dim" style={{ marginTop: 14 }}>{tn('{0} session', '{0} sessions', sessions.length)}</div>
      {sessions.slice(0, 8).map(s => <SessionRow key={s.id} s={s} S={S} onClick={() => sessionSheet(s)} />)}
      {sessions.length > 8 && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <Button size="sm" variant="ghost" trailingIcon="chevronRight" onClick={allSessionsSheet}>{t('All sessions')}</Button>
      </div>}
    </>}
  </div>
}

/* ================================================================== sheets ============= */

export function allSessionsSheet() {
  ui().openSheet(() => <AllSessions />)
}
function AllSessions() {
  const S = useStore(s => s.S)
  return <>
    <h3>{t('Sessions')}</h3>
    {(S.sessions || []).map(s => <SessionRow key={s.id} s={s} S={S} onClick={() => sessionSheet(s)} />)}
  </>
}

/** Add a session, or edit / delete `existing`. */
export function sessionSheet(existing) {
  ui().openSheet(close => <SessionSheet existing={existing} close={close} />)
}
function SessionSheet({ existing, close }) {
  const S = useStore(s => s.S)
  const mi = distUnitOf(S) === 'mi'
  const at = existing ? new Date(existing.start) : new Date(Date.now() - 3600000)
  const [type, setType] = useState(existing?.type || 'run')
  const [day, setDay] = useState(isoOf(at))
  const [time, setTime] = useState(`${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`)
  const [min, setMin] = useState(existing ? Math.round(existing.durS / 60) : 30)
  const swim = type === 'swim'
  // Swims in metres (yards); everything else in km (miles).
  const perUnit = swim ? (mi ? 0.9144 : 1) : (mi ? 1609.344 : 1000)
  const [dist, setDist] = useState(existing?.distM ? Math.round(existing.distM / perUnit * 100) / 100 : null)
  const [hr, setHr] = useState(existing?.avgHr ?? null)
  const [kcal, setKcal] = useState(existing?.kcal ?? null)
  const [name, setName] = useState(existing?.name || '')
  const save = () => {
    const start = new Date(`${day}T${time || '00:00'}:00`).getTime()
    const s = cleanSession({
      type, start, durS: (Number(min) || 0) * 60, distM: dist ? dist * perUnit : undefined,
      avgHr: hr || undefined, kcal: kcal || undefined, name: name.trim() || undefined,
      src: existing?.src || 'manual', srcId: existing?.srcId, id: existing?.id,
    })
    if (!s) { toast(t('Enter how long it took')); return }
    update(st => {
      const rest = (st.sessions || []).filter(x => x.id !== s.id)
      st.sessions = existing ? [...rest, { ...existing, ...s }].sort((a, b) => b.start - a.start) : addSessions(rest, [s], 'manual').sessions
    })
    close(); toast(existing ? t('Session saved') : t('Session added'))
  }
  const del = () => { update(st => { st.sessions = (st.sessions || []).filter(x => x.id !== existing.id) }); close(); toast(t('Session deleted')) }
  return <>
    <h3>{existing ? t('Edit session') : t('Add session')}</h3>
    {existing && existing.src !== 'manual' && <div className="small dim" style={{ marginBottom: 8 }}>{t('From {0}', existing.src)}</div>}
    <SelectRow icon={TYPE_ICON[type]} iconTint={TYPE_TINT[type]} title={t('Type')} value={type}
      options={SESSION_TYPES.map(k => ({ value: k, label: t(sessionLabel(k)) }))} onChange={setType} sheetTitle={t('Type')} />
    <div className="row" style={{ gap: 10, marginTop: 10 }}>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Date')}</span>
        <TextField type="date" value={day} max={todayISO()} onChange={e => setDay(e.target.value)} /></label>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Start')}</span>
        <TextField type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
    </div>
    <div className="row" style={{ gap: 10, marginTop: 10 }}>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Minutes')}</span>
        <NumberField className="field" value={min} onChange={setMin} decimal={false} /></label>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Distance')} ({swim ? (mi ? 'yd' : 'm') : (mi ? 'mi' : 'km')})</span>
        <NumberField className="field" value={dist} onChange={setDist} nullable decimal={!swim} /></label>
    </div>
    <div className="row" style={{ gap: 10, marginTop: 10 }}>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Avg heart rate')}</span>
        <NumberField className="field" value={hr} onChange={setHr} nullable decimal={false} /></label>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Calories')}</span>
        <NumberField className="field" value={kcal} onChange={setKcal} nullable decimal={false} /></label>
    </div>
    <label style={{ display: 'block', marginTop: 10 }}><span className="small dim" style={{ display: 'block', marginBottom: 4 }}>{t('Name (optional)')}</span>
      <TextField value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder={t(sessionLabel(type))} /></label>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
    {existing && <><div style={{ height: 8 }} /><Button variant="ghost" icon="trash" style={{ color: 'var(--red)' }} onClick={del}>{t('Delete session')}</Button></>}
  </>
}

/** Steps, sleep and resting heart rate for one day, typed in. */
export function daySheet(d = todayISO()) {
  ui().openSheet(close => <DaySheet d={d} close={close} />)
}
function DaySheet({ d, close }) {
  const S = useStore(s => s.S)
  const cur = dayOf(S, d) || {}
  const [steps, setSteps] = useState(cur.steps ?? null)
  const [sleepH, setSleepH] = useState(cur.sleepMin ? Math.round(cur.sleepMin / 6) / 10 : null)
  const [restHr, setRestHr] = useState(cur.restHr ?? null)
  const [goal, setGoal] = useState(S.stepGoal || 8000)
  const save = () => {
    update(st => {
      st.activity = mergeDays(st.activity || [], [{ d, steps, sleepMin: sleepH ? sleepH * 60 : undefined, restHr }], 'manual').activity
      if (goal > 0) st.stepGoal = Math.round(goal)
    })
    close(); toast(t('Saved'))
  }
  return <>
    <h3>{t('Activity')}</h3>
    <div className="muted small" style={{ marginBottom: 10 }}>{fmtDate(d, true)}</div>
    <div className="row" style={{ gap: 10 }}>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Steps')}</span><NumberField className="field" value={steps} onChange={setSteps} nullable decimal={false} /></label>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Step goal')}</span><NumberField className="field" value={goal} onChange={setGoal} decimal={false} /></label>
    </div>
    <div className="row" style={{ gap: 10, marginTop: 10 }}>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Sleep (hours)')}</span><NumberField className="field" value={sleepH} onChange={setSleepH} nullable /></label>
      <label style={{ flex: 1, minWidth: 0 }}><span className="small dim" style={{ display: "block", marginBottom: 4 }}>{t('Resting HR (bpm)')}</span><NumberField className="field" value={restHr} onChange={setRestHr} nullable decimal={false} /></label>
    </div>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
  </>
}

/* ================================================================== import ============= */

const readBytes = f => new Promise((res, rej) => {
  const rd = new FileReader()
  rd.onload = () => res(rd.result)
  rd.onerror = () => rej(rd.error)
  rd.readAsArrayBuffer(f)
})

/** Read the picked files and show what they would add. */
export async function importActivityFiles(files) {
  if (!files?.length) return
  toast(t('Reading files…'))
  let r
  try { r = await parseActivityFiles([...files], readBytes) } catch { toast(t('Could not read that file')); return }
  if (!r.days.length && !r.sessions.length) {
    toast(t('Nothing to import. Pick an Apple Health export.xml, or FIT, GPX or TCX files.')); return
  }
  ui().openSheet(close => <ImportActivitySummary r={r} close={close} />)
}
function ImportActivitySummary({ r, close }) {
  const S = useStore(s => s.S)
  const preview = useMemo(() => {
    const d = mergeDays(S.activity || [], r.days, r.sources[0])
    const s = addSessions(S.sessions || [], r.sessions, r.sources[0])
    return { days: d.changed, sessions: s.added }
  }, [S.activity, S.sessions, r])
  const range = r.days.length ? `${fmtDate(r.days[0].d, true)} – ${fmtDate(r.days[r.days.length - 1].d, true)}` : ''
  const go = () => {
    update(st => {
      st.activity = mergeDays(st.activity || [], r.days, r.sources[0]).activity
      st.sessions = addSessions(st.sessions || [], r.sessions, r.sources[0]).sessions
    })
    close(); toast(t('Activity imported'))
  }
  const fresh = preview.days || preview.sessions
  return <>
    <h3>{t('Import activity')}</h3>
    <div className="muted small" style={{ marginBottom: 10 }}>{r.sources.join(', ')}{range ? ' · ' + range : ''}</div>
    <div className="row" style={{ gap: 10 }}>
      <Stat icon="figureRun" tint="var(--orange)" label={t('New sessions')} value={String(preview.sessions)} />
      <Stat icon="bolt" tint="var(--acc)" label={t('Days updated')} value={String(preview.days)} />
    </div>
    {r.skipped > 0 && <div className="small dim" style={{ marginTop: 8 }}>{t('Files skipped (not ones we can read): {0}', r.skipped)}</div>}
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={go} disabled={!fresh}>{fresh ? t('Import') : t('Nothing new to import')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}
