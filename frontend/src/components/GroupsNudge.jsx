// Home: a card when a coach is waiting for an answer — an invitation to a group, or a routine
// sent to you (views/Groups.jsx). Asked once when Home opens; quiet when there is nothing.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { DEMO } from '../lib/demo.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

export function GroupsNudge() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const [box, setBox] = useState(null)
  useEffect(() => {
    if (!user || DEMO) return
    let gone = false
    api('/api/groups/inbox').then(b => { if (!gone) setBox(b) }).catch(() => {})
    return () => { gone = true }
  }, [user])
  const invites = box?.invites || [], sent = box?.assignments || []
  if (!invites.length && !sent.length) return null
  const line = sent.length === 1 ? t('{0} sent you {1}', sent[0].coach, sent[0].plan?.routines?.[0]?.name || t('a routine'))
    : sent.length > 1 ? t('{0} routines from your coach are waiting', sent.length)
    : invites.length === 1 ? t('{0} invited you to {1}', invites[0].coach, invites[0].name)
    : t('{0} group invitations are waiting', invites.length)
  return <div className="card">
    <div className="row between" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="lrow-i" style={{ '--tint': 'var(--green)' }}><Icon name="person" /></span>
        <div><div className="tt" style={{ fontWeight: 600 }}>{line}</div><div className="small muted">{t('Nothing changes in your plan until you accept.')}</div></div>
      </div>
      <Button size="sm" variant="tinted" onClick={() => nav('/groups')}>{t('Review')}</Button>
    </div>
  </div>
}
