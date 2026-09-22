import { describe, expect, it, vi } from 'vitest'
import type { TeamMember, TeamSnapshot } from './api.js'
import { RosterRow, canOpenMember, liveMemberCount, memberMarkerLabel, rosterIsVisible } from './roster.js'

const t = (key: string): string => ({
  live: 'Live',
  pausedState: 'Paused',
  notLive: 'Not live',
  unbound: 'Unbound',
  openSession: 'Open Session',
}[key] ?? key)

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    memberId: 'ada',
    displayName: 'Ada',
    role: 'builder',
    availability: 'available',
    sessionId: 'session-ada',
    live: true,
    status: 'idle',
    bindingGeneration: 1,
    contractRevision: 1,
    ...overrides,
  }
}

function snapshot(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    teamId: 'B1 Check',
    workspacePath: '/workspace',
    revision: 1,
    members: [member()],
    ...overrides,
  }
}

describe('sidebar roster', () => {
  it('is hidden when the snapshot read failed', () => {
    expect(rosterIsVisible(null)).toBe(false)
  })

  it('is hidden when no team exists', () => {
    expect(rosterIsVisible(snapshot({ teamId: '' }))).toBe(false)
  })

  it('is hidden when the team has no members', () => {
    expect(rosterIsVisible(snapshot({ members: [] }))).toBe(false)
  })

  it('shows the live count from the snapshot', () => {
    expect(liveMemberCount(snapshot({ members: [member(), member({ memberId: 'mina', live: false }), member({ memberId: 'zed', availability: 'paused' })] }))).toBe(2)
  })

  it('renders each row as exactly a name and marker', () => {
    const element = RosterRow({ member: member(), sessions: { open: vi.fn() }, t })
    expect(element.type).toBe('button')
    expect((element.props.children as unknown[]).length).toBe(2)
    expect(element.props.children[0].props.children).toBe('Ada')
    expect(element.props.children[1].props['aria-label']).toBe('Live')
  })

  it('marks paused live members accessibly', () => {
    expect(memberMarkerLabel(member({ availability: 'paused' }), t)).toBe('Live · Paused')
    expect(memberMarkerLabel(member({ live: false }), t)).toBe('Not live')
  })

  it('does not activate an unbound row', () => {
    const sessions = { open: vi.fn() }
    const element = RosterRow({ member: member({ sessionId: null }), sessions, t })
    expect(element.type).toBe('div')
    expect(canOpenMember(member({ sessionId: null }))).toBe(false)
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('opens a bound row through the native sessions service', () => {
    const open = vi.fn()
    const element = RosterRow({ member: member(), sessions: { open }, t })
    element.props.onClick()
    expect(open).toHaveBeenCalledWith('session-ada')
  })
})
