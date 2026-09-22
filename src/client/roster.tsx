import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { TeamMember, TeamSnapshot } from './api.js'
import type { LocaleKey } from './locales.js'
import { fetchTeamSnapshot } from './api.js'
import './styles.js'

export type RosterContext = {
  readonly sessions: { open(sessionId: string): void }
  readonly t: (key: LocaleKey) => string
}

export type RosterProps = {
  readonly ctx?: RosterContext
}

function fallback(key: LocaleKey): string { return key }

export function rosterIsVisible(snapshot: TeamSnapshot | null, sessions?: unknown): boolean {
  // Without the sessions service the roster's only action cannot work, so it
  // stays hidden rather than rendering rows that silently do nothing.
  return sessions !== undefined
    && snapshot !== null
    && snapshot.teamId.trim().length > 0
    && snapshot.members.length > 0
}

export function liveMemberCount(snapshot: TeamSnapshot): number {
  return snapshot.members.filter((member) => member.live).length
}

export function memberMarkerLabel(member: TeamMember, t: (key: LocaleKey) => string): string {
  if (member.sessionId === null) return t('unbound')
  if (!member.live) return t('notLive')
  if (member.availability === 'paused') return `${t('live')} · ${t('pausedState')}`
  return t('live')
}

export function canOpenMember(member: TeamMember): boolean {
  return member.sessionId !== null
}

export function openMember(member: TeamMember, sessions: RosterContext['sessions']): void {
  if (member.sessionId !== null) sessions.open(member.sessionId)
}

function markerState(member: TeamMember): 'live' | 'paused' | 'not-live' | 'unbound' {
  if (member.sessionId === null) return 'unbound'
  if (!member.live) return 'not-live'
  if (member.availability === 'paused') return 'paused'
  return 'live'
}

export type RosterRowProps = {
  readonly member: TeamMember
  readonly sessions: RosterContext['sessions']
  readonly t: (key: LocaleKey) => string
}

export function RosterRow(props: RosterRowProps): React.ReactElement {
  const marker = <span className="dshLiveTeamsRosterMarker" data-state={markerState(props.member)} role="img" aria-label={memberMarkerLabel(props.member, props.t)} />
  const name = <span className="dshLiveTeamsRosterName">{props.member.displayName}</span>
  if (!canOpenMember(props.member)) {
    return <div className="dshLiveTeamsRosterRow dshLiveTeamsRosterRowUnbound" role="listitem">{name}{marker}</div>
  }
  return <button className="dshLiveTeamsRosterRow" type="button" title={props.t('openSession')} onClick={() => openMember(props.member, props.sessions)}>{name}{marker}</button>
}

type RosterSurfaceProps = {
  readonly snapshot: TeamSnapshot
  readonly ctx: RosterContext
  /** Re-read the snapshot; called when the popover opens so the count is current. */
  readonly onRefresh: () => void
}

function RosterSurface(props: RosterSurfaceProps): React.ReactElement {
  const t = props.ctx.t
  const entryRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const count = liveMemberCount(props.snapshot)
  const popoverId = 'dsh-live-teams-roster-popover'
  const close = useCallback(() => {
    setOpen(false)
    entryRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    props.onRefresh()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target) === true) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [close, open])

  return <div className="dshLiveTeamsRoster" ref={rootRef}>
    <button
      ref={entryRef}
      className="dshLiveTeamsRosterEntry"
      type="button"
      aria-label={`${props.snapshot.teamName ?? props.snapshot.teamId}: ${count} ${t('liveMembers')}`}
      aria-haspopup="dialog"
      aria-controls={popoverId}
      aria-expanded={open}
      onClick={() => {
        if (open) {
          close()
        } else {
          setOpen(true)
        }
      }}
    >
      <span className="dshLiveTeamsRosterMark" aria-hidden="true">◆</span>
      <span className="dshLiveTeamsRosterTeam">{props.snapshot.teamName ?? props.snapshot.teamId}</span>
      <span className="dshLiveTeamsRosterSummary">{count} {t('liveMembers')}</span>
    </button>
    {open && <div className="dshLiveTeamsRosterPopover" id={popoverId} role="dialog" aria-label={t('roster')}>
      <ul className="dshLiveTeamsRosterList">
        {props.snapshot.members.map((member) => <li className="dshLiveTeamsRosterListItem" key={member.memberId}>
          <RosterRow member={member} sessions={props.ctx.sessions} t={t} />
        </li>)}
      </ul>
    </div>}
  </div>
}

export function Roster(props: RosterProps): React.ReactElement | null {
  const t = props.ctx?.t ?? fallback
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null)

  const inFlight = useRef<AbortController | null>(null)
  const refresh = useCallback((): void => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    void fetchTeamSnapshot(undefined, controller.signal).then((next) => {
      if (!controller.signal.aborted) setSnapshot(next)
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot(null)
    })
  }, [])

  useEffect(() => {
    refresh()
    return () => inFlight.current?.abort()
  }, [refresh])

  const sessions = props.ctx?.sessions
  if (!rosterIsVisible(snapshot, sessions) || snapshot === null || sessions === undefined) return null
  return <RosterSurface snapshot={snapshot} ctx={{ sessions, t }} onRefresh={refresh} />
}

export default Roster
