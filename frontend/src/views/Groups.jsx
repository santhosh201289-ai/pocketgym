// Groups (api/groups.js): a coach, the people they coach, and the routines they send.
//
// For everyone: invitations and routines waiting for an answer, and the groups you are in.
// Nothing reaches your plan until you accept it here (lib/group-assign.js).
// For a coach (an admin, or a profile an admin made one): groups, their members, what each
// active member trained, and "Send a routine" for some or all of them.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { DAYN, weekOrder, weekStartOf, fmtDate, fmtNum, exCount, todayISO } from '../lib/format.js'
import { buildPlanBundle } from '../lib/plan-share.js'
import { acceptAssignment, assignmentClashes, readAssignment } from '../lib/group-assign.js'
import { fmtDist, fmtDur, fmtSleep } from '../lib/activity.js'
import Icon from '../components/Icon.jsx'
import { Button, Row, Section } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'

const toast = m => useUI.getState().toast(m)
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })
const daysText = (weekly, dates) => [
  ...(weekly || []).map(d => t('Every {0}', t(DAYN[d]))),
  ...(dates || []).map(d => fmtDate(d)),
].join(' · ')

export default function Groups() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const [data, setData] = useState(null)
  const [inbox, setInbox] = useState(null)
  const [view, setView] = useState({ kind: 'list' })
  const [error, setError] = useState(null)
  const load = () => Promise.all([api('/api/groups'), api('/api/groups/inbox')])
    .then(([g, i]) => { setData(g); setInbox(i); setError(null) })
    .catch(e => setError(e.message))
  useEffect(() => { if (user) load() }, [user])

  if (!user) return <Page title={t('Groups')} back={() => nav('/settings/account')}>
    <div className="empty">{t('Sign in to a Pocket Gym server to join a coach’s group.')}</div>
  </Page>
  if (view.kind === 'group') {
    const g = data?.coaching.find(x => x.id === view.id)
    if (g) return <GroupDetail group={g} onBack={() => setView({ kind: 'list' })} onChanged={setData} onMember={uid => setView({ kind: 'member', id: g.id, uid })} />
  }
  if (view.kind === 'member') {
    const g = data?.coaching.find(x => x.id === view.id)
    if (g) return <MemberDetail group={g} uid={view.uid} onBack={() => setView({ kind: 'group', id: g.id })} />
  }

  return <Page title={t('Groups')} sub={data?.coach ? t('Coaching and being coached') : t('Your coach and your group')} back={() => nav(-1)}>
    {error && <div className="empty">{error}</div>}
    {!data || !inbox ? <div className="empty">{t('Loading…')}</div> : <>
      <Inbox inbox={inbox} onDone={load} />
      {data.memberOf.some(g => g.status === 'active') && <Section title={t('Your groups')}>
        {data.memberOf.filter(g => g.status === 'active').map(g => <Row key={g.id} icon="person" iconTint="var(--indigo)" title={g.name}
          subtitle={t('Coach: {0} · they see your workouts, activity and body weight', g.coach)} accessory="chevron"
          onClick={() => confirmSheet({
            title: t('Leave {0}?', g.name),
            message: t('{0} stops seeing your training, and can send you nothing more. What you already accepted stays in your plan.', g.coach),
            confirmText: t('Leave group'), danger: true,
            onConfirm: () => post('/api/groups/respond', { group: g.id, accept: false }).then(() => { toast(t('You left {0}', g.name)); load() }).catch(e => toast(e.message)),
          })} />)}
      </Section>}
      {data.coach ? <Coaching data={data} onOpen={id => setView({ kind: 'group', id })} onChanged={setData} />
        : !data.memberOf.length && !inbox.invites.length && !inbox.assignments.length && <div className="empty plan-empty">
          <div className="ico"><Icon name="person" /></div>
          {t('No groups yet. A coach on this server adds you by your name, and you choose whether to join.')}
          <div className="small muted" style={{ marginTop: 8 }}>{t('To coach a group yourself, ask the server admin to make you a coach.')}</div>
        </div>}
    </>}
  </Page>
}

function Page({ title, sub, back, children, actions }) {
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={back} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10 }}><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
      {actions}
    </div>
    {children}
  </div>
}

/* ---------- the member's side ---------- */
function Inbox({ inbox, onDone }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const [busy, setBusy] = useState(null)
  if (!inbox.invites.length && !inbox.assignments.length) return null
  const answerInvite = (g, accept) => {
    setBusy(g.group)
    post('/api/groups/respond', { group: g.group, accept })
      .then(() => { toast(accept ? t('You joined {0}', g.name) : t('Invitation declined')); onDone() })
      .catch(e => toast(e.message)).finally(() => setBusy(null))
  }
  const answer = async (a, accept) => {
    setBusy(a.id)
    try {
      if (accept) {
        const parsed = readAssignment(a, S.unit || 'kg')
        let made = null
        update(s => { made = acceptAssignment(s, a, parsed) })
        await post('/api/groups/inbox/answer', { id: a.id, accept: true })
        toast(t('{0} added to your plan', made?.name || ''))
      } else {
        await post('/api/groups/inbox/answer', { id: a.id, accept: false })
        toast(t('Declined'))
      }
      onDone()
    } catch (e) { toast(e.message) } finally { setBusy(null) }
  }
  return <Section title={t('Waiting for you')}>
    {inbox.invites.map(g => <div key={g.group} className="card" style={{ margin: '0 0 10px' }}>
      <div className="tt" style={{ fontWeight: 600 }}>{t('{0} invited you to {1}', g.coach, g.name)}</div>
      <div className="small muted" style={{ margin: '6px 0 12px', lineHeight: 1.5 }}>
        {t('If you join, {0} sees your workouts, activity (steps, sleep, cardio) and body weight, and can send you routines. Nothing changes in your plan unless you accept it. You can leave at any time.', g.coach)}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" disabled={busy === g.group} onClick={() => answerInvite(g, true)}>{t('Join')}</Button>
        <Button disabled={busy === g.group} onClick={() => answerInvite(g, false)}>{t('Decline')}</Button>
      </div>
    </div>)}
    {inbox.assignments.map(a => {
      const r = a.plan?.routines?.[0] || {}
      const clashes = assignmentClashes(S, a)
      return <div key={a.id} className="card" style={{ margin: '0 0 10px' }}>
        <div className="small muted">{t('From {0} · {1}', a.coach, a.groupName)}</div>
        <div className="tt" style={{ fontWeight: 600, marginTop: 4 }}>{r.name}</div>
        <div className="small muted">{exCount((r.ex || []).length)}{(a.weekly?.length || a.dates?.length) ? ' · ' + daysText(a.weekly, a.dates) : ''}</div>
        {a.note && <div className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>“{a.note}”</div>}
        {clashes.length > 0 && <div className="small" style={{ marginTop: 8, color: 'var(--orange)' }}>
          {clashes.map(c => t('Replaces {0} on {1}.', c.names.join(' + '), t(DAYN[c.day]))).join(' ')}
        </div>}
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <Button variant="primary" disabled={busy === a.id} onClick={() => answer(a, true)}>{t('Accept')}</Button>
          <Button disabled={busy === a.id} onClick={() => answer(a, false)}>{t('Decline')}</Button>
        </div>
      </div>
    })}
  </Section>
}

/* ---------- the coach's side ---------- */
function NameSheet({ title, initial = '', confirm, onSave, close }) {
  const [v, setV] = useState(initial)
  return <form onSubmit={e => { e.preventDefault(); if (v.trim()) { onSave(v.trim()); close() } }}>
    <h3>{title}</h3>
    <input className="input" autoFocus maxLength={60} value={v} onChange={e => setV(e.target.value)} placeholder={t('e.g. Morning batch')} aria-label={t('Group name')} />
    <div style={{ height: 14 }} />
    <Button variant="primary" type="submit" disabled={!v.trim()}>{confirm}</Button>
  </form>
}
const nameSheet = opts => useUI.getState().openSheet(close => <NameSheet {...opts} close={close} />)

function Coaching({ data, onOpen, onChanged }) {
  const create = () => nameSheet({
    title: t('New group'), confirm: t('Create group'),
    onSave: name => post('/api/groups', { name }).then(onChanged).catch(e => toast(e.message)),
  })
  return <Section title={t('Groups you coach')}>
    {data.coaching.map(g => {
      const active = g.members.filter(m => m.status === 'active').length
      const invited = g.members.length - active
      return <Row key={g.id} icon="person" iconTint="var(--acc)" title={g.name} accessory="chevron" onClick={() => onOpen(g.id)}
        subtitle={[t('{0} active', active), invited ? t('{0} invited', invited) : null].filter(Boolean).join(' · ')} />
    })}
    <Row icon="plusCircle" iconTint="var(--acc)" title={t('New group')} accessory="chevron" onClick={create} />
  </Section>
}

function GroupDetail({ group, onBack, onChanged, onMember }) {
  const [q, setQ] = useState('')
  const [people, setPeople] = useState([])
  const [sent, setSent] = useState(null)
  const loadSent = () => api('/api/groups/sent?group=' + encodeURIComponent(group.id)).then(r => setSent(r.sent)).catch(() => setSent([]))
  useEffect(() => { loadSent() }, [group.id])
  useEffect(() => {
    if (q.trim().length < 2) { setPeople([]); return }
    const id = setTimeout(() => api(`/api/groups/people?group=${encodeURIComponent(group.id)}&q=${encodeURIComponent(q.trim())}`).then(r => setPeople(r.people)).catch(() => {}), 250)
    return () => clearTimeout(id)
  }, [q, group.id])
  const act = (path, body, said) => post(path, { group: group.id, ...body }).then(d => { onChanged(d); if (said) toast(said) }).catch(e => toast(e.message))
  const active = group.members.filter(m => m.status === 'active')
  const menu = <button className="iconbtn" aria-label={t('Rename')} onClick={() => nameSheet({
    title: t('Rename group'), initial: group.name, confirm: t('Save'), onSave: name => act('/api/groups/rename', { name }),
  })}><Icon name="pencil" /></button>

  return <Page title={group.name} sub={t('{0} active members', active.length)} back={onBack} actions={menu}>
    <div style={{ margin: '4px 0 14px' }}>
      <Button variant="primary" icon="share" disabled={!active.length} onClick={() => assignSheet(group, active, null, loadSent)}>{t('Send a routine')}</Button>
      {!active.length && <div className="small muted" style={{ marginTop: 6 }}>{t('Once someone joins, you can send them routines.')}</div>}
    </div>

    <Section title={t('Members')}>
      {!group.members.length && <Row title={t('Nobody yet')} subtitle={t('Find people by name below.')} />}
      {group.members.map(m => <Row key={m.uid} icon="personCircle" iconTint={m.status === 'active' ? 'var(--green)' : 'var(--grey)'}
        title={m.name} subtitle={m.status === 'active' ? t('Active since {0}', fmtDate(new Date(m.at).toISOString().slice(0, 10))) : t('Invited · waiting for them to accept')}
        accessory={m.status === 'active' ? 'chevron' : 'none'}
        onClick={m.status === 'active' ? () => onMember(m.uid) : () => confirmSheet({
          title: t('Withdraw the invitation to {0}?', m.name), confirmText: t('Withdraw'), danger: true,
          onConfirm: () => act('/api/groups/members/remove', { uid: m.uid }),
        })} />)}
    </Section>

    <Section title={t('Add people')} footer={t('They get an invitation and decide whether to join. You see nothing of theirs until they do.')}>
      <div className="lrow"><input className="input" style={{ width: '100%' }} value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search by name')} aria-label={t('Search by name')} /></div>
      {people.map(p => <Row key={p.uid} icon="personCircle" title={p.name}
        subtitle={p.status === 'active' ? t('In this group') : p.status === 'invited' ? t('Invited') : null}
        accessory={p.status ? 'none' : 'chevron'}
        onClick={p.status ? undefined : () => act('/api/groups/members/add', { uid: p.uid }, t('{0} invited', p.name)).then(() => setQ(''))} />)}
    </Section>

    {sent?.length > 0 && <Section title={t('Sent')}>
      {sent.slice(0, 30).map(a => <Row key={a.id} icon={a.status === 'accepted' ? 'checkCircle' : a.status === 'declined' ? 'xmark' : 'hourglass'}
        iconTint={a.status === 'accepted' ? 'var(--green)' : a.status === 'declined' ? 'var(--red)' : 'var(--orange)'}
        title={`${a.routine} → ${a.toName}`}
        subtitle={[a.status === 'accepted' ? t('Accepted') : a.status === 'declined' ? t('Declined') : t('Waiting'), daysText(a.weekly, a.dates)].filter(Boolean).join(' · ')} />)}
    </Section>}

    <div style={{ margin: '24px 0' }}>
      <Button variant="ghost" className="dim" icon="trash" onClick={() => confirmSheet({
        title: t('Delete {0}?', group.name),
        message: t('Everyone leaves the group and what is still waiting in their inboxes is withdrawn. What they already accepted stays in their plans.'),
        confirmText: t('Delete group'), danger: true,
        onConfirm: () => post('/api/groups/delete', { group: group.id }).then(d => { onChanged(d); onBack() }).catch(e => toast(e.message)),
      })}>{t('Delete group')}</Button>
    </div>
  </Page>
}

function MemberDetail({ group, uid, onBack }) {
  const [m, setM] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(null)
  useEffect(() => {
    api(`/api/groups/member?group=${encodeURIComponent(group.id)}&uid=${encodeURIComponent(uid)}`).then(setM).catch(e => setError(e.message))
  }, [group.id, uid])
  const S = useStore(s => s.S)
  if (error) return <Page title={t('Member')} back={onBack}><div className="empty">{error}</div></Page>
  if (!m) return <Page title={t('Member')} back={onBack}><div className="empty">{t('Loading…')}</div></Page>

  const recent = m.perWeek.slice(-4)
  const perWeek = recent.reduce((a, w) => a + w.n, 0) / (recent.length || 1)
  const avg = f => { const xs = m.activity.map(e => e[f]).filter(v => v > 0); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null }
  const steps = avg('steps'), sleep = avg('sleepMin')
  const weight = m.bodyweight.at(-1)
  const routineName = id => m.routines.find(r => r.id === id)?.name
  const wsDay = weekStartOf(S)
  return <Page title={m.name} sub={t('In {0} since {1}', group.name, fmtDate(new Date(m.since).toISOString().slice(0, 10)))} back={onBack}>
    <div className="tiles" style={{ textAlign: 'start' }}>
      <div className="tile"><div className="l">{t('Last workout')}</div><div className="v" style={{ fontSize: '1rem' }}>{m.lastWorkout ? fmtDate(m.lastWorkout, true) : '–'}</div></div>
      <div className="tile"><div className="l">{t('Per week')}</div><div className="v" style={{ fontSize: '1.1rem' }}>{fmtNum(Math.round(perWeek * 10) / 10)}</div></div>
      <div className="tile"><div className="l">{t('Steps a day')}</div><div className="v" style={{ fontSize: '1.1rem' }}>{steps ? fmtNum(Math.round(steps)) : '–'}</div></div>
      <div className="tile"><div className="l">{t('Sleep')}</div><div className="v" style={{ fontSize: '1rem' }}>{sleep ? fmtSleep(sleep) : '–'}</div></div>
      <div className="tile"><div className="l">{t('Body weight')}</div><div className="v" style={{ fontSize: '1rem' }}>{weight ? `${fmtNum(weight.w)} ${m.unit}` : '–'}</div></div>
    </div>
    <div style={{ margin: '12px 0' }}>
      <Button variant="primary" icon="share" onClick={() => assignSheet(group, [{ uid, name: m.name }], uid)}>{t('Send {0} a routine', m.name)}</Button>
    </div>

    <Section title={t('Their week')}>
      {weekOrder(wsDay).map(d => <Row key={d} title={t(DAYN[d])}
        subtitle={(m.week[d] || []).map(routineName).filter(Boolean).join(' + ') || t('Rest')} />)}
    </Section>

    <Section title={t('Workouts, last 12 weeks')}>
      {!m.workouts.length && <Row title={t('Nothing logged yet')} />}
      {m.workouts.slice().reverse().map((w, i) => <div key={w.d + i}>
        <Row icon="dumbbell" title={`${fmtDate(w.d, true)} · ${w.name || t('Workout')}`}
          subtitle={[t('{0} sets', w.sets), w.vol ? `${fmtNum(w.vol)} ${m.unit}` : null, w.minutes ? t('{0} min', w.minutes) : null, w.prs ? t('{0} PRs', w.prs) : null].filter(Boolean).join(' · ')}
          accessory={open === i ? 'chevronUp' : 'chevronDown'} onClick={() => setOpen(open === i ? null : i)} />
        {open === i && <div className="small" style={{ padding: '4px 16px 12px', lineHeight: 1.6 }}>
          {w.entries.map((e, j) => <div key={j}><b>{e.name}</b>: {e.sets.filter(s => !s.warmup).map(s => (s.sec ? `${s.sec}s` : `${s.w ? fmtNum(s.w) + '×' : ''}${s.r ?? ''}`) + (s.done ? '' : ' ✗')).join(', ')}</div>)}
        </div>}
      </div>)}
    </Section>

    {m.cardio.length > 0 && <Section title={t('Cardio, last 30 days')}>
      {m.cardio.slice().reverse().map((c, i) => <Row key={i} icon="figureRun" title={`${fmtDate(c.d, true)} · ${t(c.type.charAt(0).toUpperCase() + c.type.slice(1))}`}
        subtitle={[c.distM ? fmtDist(c.distM, S, c.type) : null, c.durS ? fmtDur(c.durS) : null, c.avgHr ? t('{0} bpm', c.avgHr) : null].filter(Boolean).join(' · ')} />)}
    </Section>}
  </Page>
}

/* ---------- sending a routine ---------- */
export const assignSheet = (group, members, only, onSent) => useUI.getState().openSheet(close => <AssignSheet group={group} members={members} only={only} onSent={onSent} close={close} />)

function AssignSheet({ group, members, only, onSent, close }) {
  const S = useStore(s => s.S)
  const [rid, setRid] = useState(S.routines[0]?.id || null)
  const [weekly, setWeekly] = useState([])
  const [dates, setDates] = useState([])
  const [date, setDate] = useState('')
  const [to, setTo] = useState(only ? [only] : members.map(m => m.uid))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const toggle = (xs, set, v) => set(xs.includes(v) ? xs.filter(x => x !== v) : [...xs, v])
  const send = async () => {
    const r = S.routines.find(x => x.id === rid)
    if (!r) return
    setBusy(true)
    try {
      const plan = buildPlanBundle({ ...S, routines: [r], week: {} }, r.name)
      await post('/api/groups/assign', { group: group.id, to: to.length === members.length && !only ? 'all' : to, plan, weekly, dates, note })
      toast(t('{0} sent. It waits for them to accept.', r.name))
      onSent?.()
      close()
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }
  if (!S.routines.length) return <><h3>{t('Send a routine')}</h3><div className="muted">{t('Make a routine in Plan first, then send it from here.')}</div></>
  return <>
    <h3>{t('Send a routine')}</h3>
    <div className="small muted" style={{ marginBottom: 10 }}>{t('From your own routines. It waits in their inbox until they accept it.')}</div>
    <div className="list">
      {S.routines.map(r => <button key={r.id} className={'item' + (r.id === rid ? ' on' : '')} aria-pressed={r.id === rid} onClick={() => setRid(r.id)} style={{ width: '100%', textAlign: 'start' }}>
        <div className="grow"><div className="tt">{r.name}</div><div className="ss">{exCount((r.ex || []).length)}</div></div>
        {r.id === rid && <Icon name="check" />}
      </button>)}
    </div>
    <h4 className="sec" style={{ margin: '14px 0 6px' }}>{t('Every week on')}</h4>
    <div className="chips">
      {weekOrder(weekStartOf(S)).map(d => <button key={d} className={'chip nocap' + (weekly.includes(d) ? ' on' : '')} aria-pressed={weekly.includes(d)}
        onClick={() => toggle(weekly, setWeekly, d)}>{t(DAYN[d]).slice(0, 3)}</button>)}
    </div>
    <h4 className="sec" style={{ margin: '14px 0 6px' }}>{t('Or on a date')}</h4>
    <div className="row" style={{ gap: 8 }}>
      <input className="input" type="date" min={todayISO()} value={date} onChange={e => setDate(e.target.value)} aria-label={t('Date')} />
      <Button size="sm" disabled={!date || dates.includes(date)} onClick={() => { setDates([...dates, date].sort()); setDate('') }}>{t('Add')}</Button>
    </div>
    {dates.length > 0 && <div className="chips" style={{ marginTop: 8 }}>
      {dates.map(d => <button key={d} className="chip nocap on" onClick={() => setDates(dates.filter(x => x !== d))}>{fmtDate(d)} ✕</button>)}
    </div>}
    {!only && members.length > 1 && <>
      <h4 className="sec" style={{ margin: '14px 0 6px' }}>{t('To')}</h4>
      <div className="chips">
        {members.map(m => <button key={m.uid} className={'chip nocap' + (to.includes(m.uid) ? ' on' : '')} aria-pressed={to.includes(m.uid)}
          onClick={() => toggle(to, setTo, m.uid)}>{m.name}</button>)}
      </div>
    </>}
    <textarea className="input" rows={2} maxLength={500} style={{ marginTop: 14 }} value={note} onChange={e => setNote(e.target.value)} placeholder={t('A note for them (optional)')} />
    <div style={{ height: 14 }} />
    <Button variant="primary" disabled={busy || !rid || !to.length} onClick={send}>{to.length > 1 ? t('Send to {0} people', to.length) : t('Send')}</Button>
    {!weekly.length && !dates.length && <div className="small muted" style={{ marginTop: 6 }}>{t('No day picked: it is added to their routines without a day.')}</div>}
  </>
}
