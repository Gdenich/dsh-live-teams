import { describe, expect, it, vi, afterEach } from 'vitest'
import { addTeamMember, canOpenWorkspaceRoles, fetchTeamJournal, fetchTeamRoles, fetchTeamSnapshot, interruptTeamMember, removeTeamMember } from './api.js'

function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    teamId: 'team-1',
    workspacePath: '/w',
    revision: 2,
    members: [
      { memberId: 'm-1', displayName: 'One', role: 'engineer', availability: 'available', sessionId: null, live: false, status: 'unknown', bindingGeneration: 0, contractRevision: 0 },
    ],
    ...extra,
  })
}

afterEach(() => { vi.unstubAllGlobals() })

function respondWith(payload: string): void {
  vi.stubGlobal('fetch', async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }))
}

describe('team journal parsing', () => {
  it('parses journal entries and scopes the query', async () => {
    let requested = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested = String(input); return new Response(JSON.stringify({ teamId: 'team-1', entries: [{ id: 'j-1', kind: 'future/event', category: 'other', at: 1, summary: 'Event future/event', refs: {} }] }), { status: 200, headers: { 'content-type': 'application/json' } }) })
    await expect(fetchTeamJournal('session-1', 25)).resolves.toMatchObject({ teamId: 'team-1', entries: [{ kind: 'future/event', refs: {} }] })
    expect(requested).toContain('session=session-1')
    expect(requested).toContain('limit=25')
  })
})

describe('team roles parsing', () => {
  it('parses role summaries and open capability', async () => {
    respondWith(JSON.stringify({ globalDirectory: '/g', workspaceDirectory: '/w', workspaceDirectoryExists: false, openAvailable: true, globalOpenAvailable: false, roles: [{ id: 'builder', name: 'Builder', aliases: ['engineer'], source: 'global', overridden: false }] }))
    const result = await fetchTeamRoles()
    expect(result.roles[0]).toMatchObject({ id: 'builder', aliases: ['engineer'], source: 'global' })
    expect(result.globalOpenAvailable).toBe(false)
    expect(canOpenWorkspaceRoles(result)).toBe(false)
    expect(canOpenWorkspaceRoles({ openAvailable: true, workspaceDirectoryExists: true })).toBe(true)
  })
})

describe('team member interruption parsing', () => {
  it('parses the re-read status and scopes the request', async () => {
    let request: RequestInit | undefined
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => { request = init; return new Response(JSON.stringify({ memberId: 'm-1', interrupted: true, status: 'idle' }), { status: 200, headers: { 'content-type': 'application/json' } }) })
    await expect(interruptTeamMember('m-1', 'session-1')).resolves.toMatchObject({ memberId: 'm-1', interrupted: true, status: 'idle' })
    expect(JSON.parse(String(request?.body))).toMatchObject({ memberId: 'm-1', sessionId: 'session-1' })
  })
})

describe('team member removal parsing', () => {
  it('parses the frozen removed shape', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ teamId: 'team-1', memberId: 'm-1', revision: 3, applied: true, retried: false, removed: { memberId: 'm-1', displayName: 'One', role: 'engineer', sessionId: 's-1' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(removeTeamMember('m-1', 2)).resolves.toMatchObject({ removed: { memberId: 'm-1', sessionId: 's-1' } })
  })
})

describe('adding a member', () => {
  it('scopes the request in the query and keeps the joining Session in the body', async () => {
    let requested = ''
    let request: RequestInit | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input)
      request = init
      return new Response(JSON.stringify({ teamId: 'team-1', memberId: 'm-2', sessionId: 's-newcomer', revision: 4, applied: true, retried: false, member: { memberId: 'm-2', displayName: 'Newcomer', role: 'reviewer', availability: 'available', sessionId: 's-newcomer', live: false, status: 'unknown', bindingGeneration: 1, contractRevision: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await expect(addTeamMember({ sessionId: 's-newcomer', displayName: 'Newcomer', role: 'reviewer', expectedRevision: 3 }, 's-caller')).resolves.toMatchObject({ memberId: 'm-2' })
    // The two Sessions must not collide: the query carries the tab's scope, the
    // body carries the Session that joins.
    expect(requested).toContain('session=s-caller')
    expect(JSON.parse(String(request?.body))).toMatchObject({ sessionId: 's-newcomer', displayName: 'Newcomer', role: 'reviewer', expectedRevision: 3 })
  })
})

describe('team snapshot parsing', () => {
  it('keeps the human-readable team name', async () => {
    respondWith(body({ teamName: 'B1 Check' }))
    const snapshot = await fetchTeamSnapshot()
    expect(snapshot.teamName).toBe('B1 Check')
  })

  it('tolerates a snapshot without a team name', async () => {
    respondWith(body())
    const snapshot = await fetchTeamSnapshot()
    expect(snapshot.teamName).toBeUndefined()
    expect(snapshot.teamId).toBe('team-1')
  })

  it('rejects a malformed snapshot instead of rendering a partial one', async () => {
    respondWith(JSON.stringify({ teamId: 'team-1' }))
    await expect(fetchTeamSnapshot()).rejects.toMatchObject({ status: 500 })
  })
})
