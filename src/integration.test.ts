import { appendFile, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamStore, readMemberBySessionSync, type MemberRecord } from './team-store.js'
import { createMembershipContextProvider } from './context-provider.js'
import { createSessionBridge } from './session-bridge.js'
import { assertSessionInTeamWorkspace } from './binding.js'
import { ERROR_CODES, LiveTeamsError } from './errors.js'
import { LIVE_TEAMS_MEMBER_NAME_ROUTE, LIVE_TEAMS_MEMBER_ROLE_ROUTE, LIVE_TEAMS_MEMBERS_ROUTE, registerLiveTeamsRoutes, type LiveTeamsMutation, type LiveTeamsMutationResult, type LiveTeamsResponse, type LiveTeamsWebServer } from './routes.js'

async function freshTeam() { const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-store-')); const store = new TeamStore({ workspacePath, workspaceId: 'ws-1', teamId: 'team-1' }); await store.open(); return { workspacePath, store } }
function addMember(store: TeamStore, expectedRevision: number, memberId: string, sessionId?: string) { return store.commit('team-1', { expectedRevision, mutate: (state) => { const record: MemberRecord = { memberId, displayName: memberId, role: 'engineer', availability: 'available', bindingGeneration: 0, contractRevision: 0, ...(sessionId === undefined ? {} : { sessionId }) }; state.members.push(record); return record } }) }

describe('host integration', () => {
  it('concurrent commits have one winner', async () => { const { store } = await freshTeam(); const results = await Promise.allSettled([addMember(store, 0, 'm-1'), addMember(store, 0, 'm-2')]); expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1); const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected'); expect(rejected).toHaveLength(1); expect(rejected[0]?.reason).toMatchObject({ code: 'REVISION_CONFLICT' }); const state = await store.open(); expect(state.members).toHaveLength(1); expect(state.revision).toBe(1) })
  it('torn trailing event is reported', async () => { const { store } = await freshTeam(); await store.appendEvent('team-1', { kind: 'audit', note: 'first' }); const eventsFile = join((await store.open()).workspacePath, '.dsh-live-teams', 'teams', 'team-1', 'events.jsonl'); await appendFile(eventsFile, '{"kind":"audit","note":"torn"'); const result = await store.readEvents('team-1'); expect(result.events).toHaveLength(1); expect(result.events[0]).toMatchObject({ note: 'first' }); expect(result.torn).toMatch(/torn/) })
  it('binding generations are monotonic', async () => { const { store } = await freshTeam(); await addMember(store, 0, 'm-1', 's-1'); expect((await store.memberBySession('team-1', 's-1'))?.bindingGeneration).toBe(0); const bound = await store.bindSession('team-1', 'm-1', 's-2', 1); expect(bound.bindingGeneration).toBe(1); expect(bound.sessionId).toBe('s-2'); expect(await store.memberBySession('team-1', 's-1')).toBeUndefined(); expect((await store.memberBySession('team-1', 's-2'))?.bindingGeneration).toBe(1); const unbound = await store.unbindSession('team-1', 'm-1', 2); expect(unbound.bindingGeneration).toBe(2); expect(await store.memberBySession('team-1', 's-2')).toBeUndefined(); expect((await store.bindSession('team-1', 'm-1', 's-3', 3)).bindingGeneration).toBe(3) })
  it('one Session cannot bind to two members', async () => { const { store } = await freshTeam(); await addMember(store, 0, 'm-1', 's-1'); await addMember(store, 1, 'm-2', 's-2'); await expect(store.bindSession('team-1', 'm-2', 's-1', 2)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' }) })
  it('context follows rebinding', async () => { const { store, workspacePath } = await freshTeam(); await addMember(store, 0, 'm-1', 's-1'); const provider = createMembershipContextProvider({ store: { memberBySessionSync: (team, sessionId) => readMemberBySessionSync({ workspacePath, teamId: team, sessionId }) }, teamId: 'team-1', teamName: 'Alpha' }); expect(provider.text({ agent: { session: { id: 's-1' } } })).toMatch(/^Member: m-1$/m); expect(provider.text({ agent: { session: { id: 's-2' } } })).toBe(''); await store.bindSession('team-1', 'm-1', 's-9', 1); expect(provider.text({ agent: { session: { id: 's-1' } } })).toBe(''); expect(provider.text({ agent: { session: { id: 's-9' } } })).toMatch(/^Member: m-1$/m); await store.unbindSession('team-1', 'm-1', 2); expect(provider.text({ agent: { session: { id: 's-9' } } })).toBe('') })
  it('bridge adopts Session without probe fields', async () => { const { store } = await freshTeam(); await addMember(store, 0, 'm-1'); const calls: unknown[][] = []; const controller = { async create(payload: Record<string, unknown>) { calls.push(['create', payload]); return { sessionId: payload.sessionId } }, async inspect(sessionId: string) { return { meta: { id: sessionId, cwd: '/w', workspaceId: 'ws-1' }, events: [] } }, async rename() { return {} }, async prompt() { return {} }, cancel() {} }; const bridge = createSessionBridge({ controller }); const descriptor = await bridge.create({ sessionId: 's-1', workspaceId: 'ws-1' }); expect(calls[0]?.[1]).toEqual({ sessionId: 's-1', workspaceId: 'ws-1' }); expect(descriptor.workspaceId).toBe('ws-1'); await store.bindSession('team-1', 'm-1', descriptor.sessionId, 1); expect((await store.memberBySession('team-1', 's-1'))?.sessionId).toBe('s-1') })
  it('empty state has no temporary files', async () => { const { workspacePath, store } = await freshTeam(); expect((await store.open()).members).toEqual([]); const entries = await readdir(join(workspacePath, '.dsh-live-teams', 'teams', 'team-1')); expect(entries).toContain('team.json'); expect(entries.filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0) })

  it('workspace guard runs before write for a foreign Session', async () => {
    const { store, workspacePath } = await freshTeam()
    const foreign = await mkdtemp(join(tmpdir(), 'live-teams-foreign-'))
    const stateBefore = await store.open()
    const handlers = new Map<string, (request: { method?: string; headers: Record<string, string>; socket: { remoteAddress?: string }; body?: string }, response: LiveTeamsResponse) => unknown>()
    const server: LiveTeamsWebServer = { port: 43120, register(route) { handlers.set(route.path, route.handler); return () => {} } }
    const bridge = createSessionBridge({ controller: { async create() { return {} }, async inspect(sessionId: string) { return { meta: { id: sessionId, cwd: foreign, workspaceId: 'ws-foreign' }, events: [] } }, async rename() { return {} }, async prompt() { return {} }, cancel() {} } })
    const guardedCreate = async (request: import('./routes.js').LiveTeamsCreateMemberRequest): Promise<import('./routes.js').LiveTeamsCreateMemberResult> => {
      const descriptor = await bridge.inspect(request.sessionId)
      if (descriptor === undefined) throw new LiveTeamsError(ERROR_CODES.SESSION_NOT_FOUND, 'missing')
      await assertSessionInTeamWorkspace({ bridge, workspacePath }, request.sessionId)
      throw new Error(`unexpected write for ${descriptor.sessionId}`)
    }
    registerLiveTeamsRoutes({ webServer: server }, { teamId: 'team-1', workspacePath, readState: async () => store.open(), createMember: guardedCreate, appendAudit: async () => { throw new Error('must not audit') } })
    const result = { statusCode: 0, body: undefined as string | undefined, setHeader() {}, end(body?: string) { result.body = body } }
    await handlers.get(LIVE_TEAMS_MEMBERS_ROUTE)?.({ method: 'POST', headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 'foreign', displayName: 'Foreign', role: 'engineer', expectedRevision: stateBefore.revision }) }, result)
    expect(result.statusCode).toBe(400)
    expect(await store.open()).toEqual(stateBefore)
  })

  it('removal ends membership, preserves Session, restores candidate eligibility, and re-adds with a new id', async () => {
    const { store, workspacePath } = await freshTeam()
    await addMember(store, 0, 'm-1', 's-1')
    const provider = createMembershipContextProvider({ store: { memberBySessionSync: (team, sessionId) => readMemberBySessionSync({ workspacePath, teamId: team, sessionId }) }, teamId: 'team-1' })
    expect(provider.text({ agent: { session: { id: 's-1' } } })).toContain('Member: m-1')
    const removed = await store.removeMember('team-1', 'm-1', 1)
    expect(removed.removed).toMatchObject({ memberId: 'm-1', sessionId: 's-1' })
    expect((await store.open()).archivedMemberIds).toEqual(['m-1'])
    expect(provider.text({ agent: { session: { id: 's-1' } } })).toBe('')
    const descriptors = [{ sessionId: 's-1', cwd: workspacePath, title: undefined, live: true, status: 'idle' as const, subagentOwned: false, workspaceId: undefined, seq: 0, agentPreset: undefined }]
    const candidates = (await import('./routes.js')).projectLiveTeamsCandidates(await store.open(), descriptors, { teamId: 'team-1', workspacePath })
    expect(candidates.candidates.map((entry) => entry.sessionId)).toEqual(['s-1'])
    await store.commit('team-1', { expectedRevision: 2, mutate: (state) => { state.members.push({ memberId: 'm-2', displayName: 'm-2', role: 'engineer', availability: 'available', sessionId: 's-1', bindingGeneration: 1, contractRevision: 0 }) } })
    const readded = await store.memberBySession('team-1', 's-1')
    expect(readded).toMatchObject({ memberId: 'm-2', bindingGeneration: 1, contractRevision: 0 })
  })

  it('name change appears in scoped context on the next assembly', async () => {
    const { store, workspacePath } = await freshTeam()
    await addMember(store, 0, 'm-1', 's-1')
    const handlers = new Map<string, (request: { method?: string; headers: Record<string, string>; socket: { remoteAddress?: string }; body?: string }, response: LiveTeamsResponse) => unknown>()
    const server: LiveTeamsWebServer = { port: 43120, register(route) { handlers.set(route.path, route.handler); return () => {} } }
    const provider = createMembershipContextProvider({ store: { memberBySessionSync: (team, sessionId) => readMemberBySessionSync({ workspacePath, teamId: team, sessionId }) }, teamId: 'team-1', teamName: 'Alpha' })
    registerLiveTeamsRoutes({ webServer: server }, { teamId: 'team-1', workspacePath, readState: async () => store.open(), applyMutation: async (request) => { const result = await store.commit('team-1', { expectedRevision: request.expectedRevision, mutate: (state) => { const member = state.members.find((entry) => entry.memberId === request.memberId); if (member === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'missing'); const from = member.displayName; member.displayName = request.value; return { member, from, to: request.value } } }); return { state: result.state, member: result.value.member, from: result.value.from, to: result.value.to } }, appendAudit: async (event) => store.appendEvent('team-1', event) })
    const result = { statusCode: 0, body: undefined as string | undefined, setHeader() {}, end(body?: string) { result.body = body } }
    await handlers.get(LIVE_TEAMS_MEMBER_NAME_ROUTE)?.({ method: 'POST', headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ memberId: 'm-1', displayName: 'Reviewer One', expectedRevision: 1 }) }, result)
    expect(result.statusCode).toBe(200)
    expect(provider.text({ agent: { session: { id: 's-1' } } })).toMatch(/^Member: Reviewer One$/m)
  })

  it('role retry succeeds after exactly one stale revision and context sees it next assembly', async () => {
    const { store, workspacePath } = await freshTeam()
    await addMember(store, 0, 'm-1', 's-1')
    const handlers = new Map<string, (request: { method?: string; headers: Record<string, string>; socket: { remoteAddress?: string }; body?: string }, response: LiveTeamsResponse) => unknown>()
    const server: LiveTeamsWebServer = { port: 43120, register(route) { handlers.set(route.path, route.handler); return () => {} } }
    const provider = createMembershipContextProvider({ store: { memberBySessionSync: (team, sessionId) => readMemberBySessionSync({ workspacePath, teamId: team, sessionId }) }, teamId: 'team-1', teamName: 'Alpha' })
    const routeState = { readState: async () => store.open(), applyMutation: async (request: LiveTeamsMutation): Promise<LiveTeamsMutationResult> => { const result = await store.commit('team-1', { expectedRevision: request.expectedRevision, mutate: (state) => { const member = state.members.find((entry) => entry.memberId === request.memberId); if (member === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'missing'); const from = member.role; member.role = request.value; return { member, from, to: request.value } } }); return { state: result.state, member: result.value.member, from: result.value.from, to: result.value.to } }, appendAudit: async (event: unknown) => store.appendEvent('team-1', event) }
    registerLiveTeamsRoutes({ webServer: server }, { teamId: 'team-1', workspacePath, ...routeState })
    await store.commit('team-1', { expectedRevision: 1, mutate: (state) => { state.updatedAt += 1 } })
    const responseState = { statusCode: 0, body: undefined as string | undefined, setHeader() {}, end(body?: string) { responseState.body = body } }
    await handlers.get(LIVE_TEAMS_MEMBER_ROLE_ROUTE)?.({ method: 'POST', headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ memberId: 'm-1', role: 'architect', expectedRevision: 1 }) }, responseState)
    expect(responseState.statusCode).toBe(200)
    expect(JSON.parse(responseState.body ?? '{}')).toMatchObject({ retried: true, member: { role: 'architect' } })
    expect(provider.text({ agent: { session: { id: 's-1' } } })).toMatch(/Roles: architect/)
  })
})
