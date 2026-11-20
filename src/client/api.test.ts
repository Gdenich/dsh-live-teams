import { describe, expect, it, vi, afterEach } from 'vitest'
import { revokeTeamTask, updateTeamTask, cancelTeamTask, resumeTeamTask, acceptTeamTask, reviseTeamTask, addTeamMember, canOpenWorkspaceRoles, fetchTeamTasks, fetchTeamTask, fetchTeamJournal, fetchTeamRoles, fetchTeamSnapshot, interruptTeamMember, removeTeamMember } from './api.js'

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

describe('non-JSON HTTP diagnostics', () => {
  it.each([200, 400, 503])('preserves HTTP %i when a task response has no JSON body', async (status) => {
    vi.stubGlobal('fetch', async () => new Response('', { status, headers: { 'content-type': 'text/plain' } }))
    await expect(fetchTeamTasks()).rejects.toMatchObject({ status, error: `invalid team response (HTTP ${status}; non-JSON body)` })
  })
})

describe('review return response parsing', () => {
  const reviewReturn = { roundId: 'r1', submissionId: 'sub1', attemptId: 'a1', generation: 1, assignee: 'worker', sessionId: 's-worker', bindingGeneration: 1, state: 'unconfirmed', at: 1, messageId: 'm1', requestId: 'req1', reason: 'execution-not-yet-observed', leadNotified: true }
  it('retains launch uncertainty in list and detail responses', async () => {
    const task = { id: 'task-1', teamId: 'team-1', title: 'Work', kind: 'work', status: 'in_progress', acceptance: ['Done'], roundLimit: 5, createdBy: 'lead', createdAt: 1, updatedAt: 2, revision: 3, reviewReturn }
    respondWith(JSON.stringify({ teamId: 'team-1', tasks: [task] }))
    expect((await fetchTeamTasks()).tasks[0]).toMatchObject({ reviewReturn })
    respondWith(JSON.stringify({ task, document: 'Work', submissions: [], rounds: [], attempts: [] }))
    expect((await fetchTeamTask('task-1')).task).toMatchObject({ reviewReturn })
  })
  it('rejects a claimed launch without turn evidence rather than hiding it', async () => {
    respondWith(JSON.stringify({ teamId: 'team-1', tasks: [{ id: 'task-1', title: 'Work', status: 'in_progress', updatedAt: 1, reviewReturn: { ...reviewReturn, state: 'started' } }] }))
    await expect(fetchTeamTasks()).rejects.toThrow()
  })
})

describe('task lifecycle response parsing', () => {
  const task = { id: 'task-1', teamId: 'team-1', title: 'Work', kind: 'work', status: 'cancelled', acceptance: ['Done'], roundLimit: 5, createdBy: 'lead', createdAt: 1, updatedAt: 2, revision: 3 }

  it('reads a completed cancellation as a task, not as a member mutation', async () => {
    respondWith(JSON.stringify({ task, archivedPath: 'archive/task-1.md', quiesced: true }))
    await expect(cancelTeamTask('task-1', 'obsolete', 's-1')).resolves.toMatchObject({ task: { status: 'cancelled' }, archivedPath: 'archive/task-1.md', quiesced: true })
  })

  it('reads an unconfirmed stop without requiring an archive or claiming success', async () => {
    respondWith(JSON.stringify({ task: { ...task, status: 'needs_human' }, quiesced: false }))
    const result = await cancelTeamTask('task-1', 'obsolete', 's-1')
    expect(result.quiesced).toBe(false)
    expect(result.archivedPath).toBeUndefined()
  })

  it('rejects contradictory cancellation results', async () => {
    respondWith(JSON.stringify({ task, quiesced: false, archivedPath: 'archive/task-1.md' }))
    await expect(cancelTeamTask('task-1', 'obsolete', 's-1')).rejects.toThrow('invalid team response')
  })

  it('scopes explicit restart and reads the ready task', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ task: { ...task, status: 'ready' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(resumeTeamTask('task-1', 's-1')).resolves.toMatchObject({ task: { status: 'ready' } })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/live-teams/task/resume')
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit)?.body))).toMatchObject({ taskId: 'task-1', sessionId: 's-1' })
  })

  it('reads revocation and contract updates with task readers, not member readers', async () => {
    respondWith(JSON.stringify({ task: { ...task, status: 'draft' }, attempt: { id: 'attempt-1', memberId: 'worker', sessionId: 's-1', generation: 1, startedAt: 1, status: 'revoked' }, quiesced: true, reassigned: false }))
    await expect(revokeTeamTask({ taskId: 'task-1', reason: 'park' }, 's-1')).resolves.toMatchObject({ task: { status: 'draft' }, quiesced: true })
    respondWith(JSON.stringify({ task: { ...task, status: 'ready' }, document: '# Updated', changed: ['title'] }))
    await expect(updateTeamTask({ taskId: 'task-1', title: 'Updated' }, 's-1')).resolves.toMatchObject({ document: '# Updated', changed: ['title'] })
  })

  it('keeps acceptance and revision response contracts separate', async () => {
    respondWith(JSON.stringify({ task: { ...task, status: 'completed' }, archivedPath: 'archive/task-1.md' }))
    await expect(acceptTeamTask('task-1', undefined, 's-1')).resolves.toMatchObject({ archivedPath: 'archive/task-1.md' })
    respondWith(JSON.stringify({ task: { ...task, status: 'in_progress' } }))
    await expect(reviseTeamTask('task-1', 'fix', 's-1')).resolves.toMatchObject({ task: { status: 'in_progress' } })
  })
})

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
