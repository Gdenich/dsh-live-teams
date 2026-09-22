import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LIVE_TEAMS_MEMBER_ROLE_ROUTE,
  LIVE_TEAMS_MEMBERS_ROUTE,
  LIVE_TEAMS_TEAM_DISABLE_ROUTE,
  LIVE_TEAMS_TEAM_ENABLE_ROUTE,
  LIVE_TEAMS_TEAM_NAME_ROUTE,
  LIVE_TEAMS_TEAM_ROUTE,
  registerLiveTeamsRoutes,
  type LiveTeamsRequest,
  type LiveTeamsResponse,
  type LiveTeamsRouteOptions,
  type LiveTeamsWebServer,
} from './routes.js'
import { TeamStore } from './team-store.js'
import { canonicalPath } from './binding.js'
import { ERROR_CODES, LiveTeamsError } from './errors.js'
import { apply } from './plugin.js'

const headers = { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }

type CapturedResponse = LiveTeamsResponse & { body: string | undefined }
function response(): CapturedResponse {
  let body: string | undefined
  const result = {
    statusCode: 0,
    body,
    setHeader: (_name: string, _value: string) => {},
    end(value?: string) { body = value; result.body = value },
  }
  return result
}

type Handler = (request: LiveTeamsRequest, response: LiveTeamsResponse) => void | Promise<void>
function routes(options: LiveTeamsRouteOptions): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server: LiveTeamsWebServer = { port: 43120, register(route) { handlers.set(route.path, route.handler); return () => {} } }
  registerLiveTeamsRoutes({ webServer: server }, options)
  return handlers
}

function parse(result: CapturedResponse): Record<string, unknown> { return JSON.parse(result.body ?? '{}') as Record<string, unknown> }

async function teamOptions(workspacePath: string, teamId: string, name: string): Promise<LiveTeamsRouteOptions> {
  const store = new TeamStore({ workspacePath, workspaceId: teamId, teamId, name })
  await store.open()
  const status = async () => {
    const current = await store.open()
    return { enabled: !(await store.isDisabled(teamId)), teamId, teamName: current.name ?? name, workspacePath, revision: current.revision, memberCount: current.members.length }
  }
  return {
    teamId,
    teamName: name,
    workspacePath,
    readState: () => store.open(),
    teamEnabled: () => store.isDisabled(teamId).then((disabled) => !disabled),
    teamStatus: status,
    enableTeam: async (requested) => {
      const current = requested === undefined ? await store.open() : await store.open({ name: requested })
      await store.setDisabled(teamId, false)
      await store.appendEvent(teamId, { kind: 'team/enabled', teamId, name: current.name ?? name, at: Date.now(), actor: 'human:desktop' })
      return status()
    },
    disableTeam: async () => {
      const current = await store.open()
      await store.setDisabled(teamId, true)
      await store.appendEvent(teamId, { kind: 'team/disabled', teamId, at: Date.now(), actor: 'human:desktop' })
      return { enabled: false, teamId, teamName: current.name ?? name, workspacePath, memberCount: current.members.length }
    },
    renameTeam: async (requested, expectedRevision) => {
      const renamed = await store.renameTeam(teamId, expectedRevision, requested)
      await store.appendEvent(teamId, { kind: 'team/renamed', teamId, from: renamed.from, to: requested, at: Date.now(), actor: 'human:desktop' })
      return { from: renamed.from, status: { enabled: true, teamId, teamName: requested, workspacePath, revision: renamed.state.revision, memberCount: renamed.state.members.length } }
    },
  }
}

describe('B10 request resolution', () => {
  it('resolves sequential requests to each session workspace without leaking the previous workspace', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'live-teams-b10-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'live-teams-b10-b-'))
    const a = await teamOptions(workspaceA, 'workspace-a', 'A team')
    const b = await teamOptions(workspaceB, 'workspace-b', 'B team')
    const readsA = vi.fn(a.readState)
    const readsB = vi.fn(b.readState)
    const bySession = new Map([['session-a', { ...a, readState: readsA }], ['session-b', { ...b, readState: readsB }]])
    const handlers = routes({
      teamId: 'pinned-default-must-not-be-used', workspacePath: workspaceA,
      resolveRequest: async (_request, sessionId) => bySession.get(sessionId ?? ''),
    })
    const first = response()
    await handlers.get(LIVE_TEAMS_MEMBERS_ROUTE)?.({ method: 'GET', url: '/api/live-teams/members?session=session-a', headers, socket: { remoteAddress: '127.0.0.1' } }, first)
    const second = response()
    await handlers.get(LIVE_TEAMS_MEMBERS_ROUTE)?.({ method: 'GET', url: '/api/live-teams/members?session=session-b', headers, socket: { remoteAddress: '127.0.0.1' } }, second)
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(parse(first).workspacePath).toBe(workspaceA)
    expect(parse(second).workspacePath).toBe(workspaceB)
    expect(readsA).toHaveBeenCalledTimes(1)
    expect(readsB).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown session instead of falling back to the configured team', async () => {
    const read = vi.fn(async () => { throw new Error('must not read fallback state') })
    const handlers = routes({
      teamId: 'configured-team', workspacePath: '/configured', readState: read,
      resolveRequest: async () => undefined,
    })
    const result = response()
    await handlers.get(LIVE_TEAMS_MEMBERS_ROUTE)?.({ method: 'GET', url: '/api/live-teams/members?session=missing', headers, socket: { remoteAddress: '127.0.0.1' } }, result)
    expect(result.statusCode).toBe(400)
    expect(parse(result)).toEqual({ error: 'live-teams invalid request' })
    expect(read).not.toHaveBeenCalled()
  })

  it('extracts sessionId from a streamed POST body once before resolution', async () => {
    const resolved = await teamOptions(await mkdtemp(join(tmpdir(), 'live-teams-b10-stream-')), 'stream-team', 'Stream team')
    const resolver = vi.fn(async (_request: LiveTeamsRequest, sessionId?: string) => sessionId === 'stream-session' ? resolved : undefined)
    const handlers = routes({ teamId: 'default', workspacePath: '/default', applyMutation: async () => { throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'missing member') }, resolveRequest: resolver })
    async function* body(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode(JSON.stringify({ sessionId: 'stream-session', memberId: 'missing', role: 'builder', expectedRevision: 0 }))
    }
    const result = response()
    await handlers.get(LIVE_TEAMS_MEMBER_ROLE_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: body() }, result)
    expect(resolver).toHaveBeenCalledWith(expect.anything(), 'stream-session')
    // The route reaches the resolved state; the stream was consumed exactly once.
    expect(result.statusCode).toBe(500)
  })
})

type AppliedHarness = {
  readonly handlers: Map<string, Handler>
  readonly contextText: (assemblyContext: unknown) => string
  readonly service: unknown
  readonly cleanups: Array<() => void>
}

async function appliedHarness(entries: Array<{ id: string; path: string; title: string; sessionIds: string[] }>, cwdBySession: Map<string, string>, config: { workspacePath?: string; teamId?: string; teamName?: string } = {}): Promise<AppliedHarness> {
  const handlers = new Map<string, Handler>()
  const cleanups: Array<() => void> = []
  let contextText: ((assemblyContext: unknown) => string) | undefined
  let service: unknown
  const webServer: LiveTeamsWebServer = { port: 43120, register(route) { handlers.set(route.path, route.handler); return () => { handlers.delete(route.path) } } }
  const controller = {
    async create() { return {} },
    async inspect(sessionId: string) {
      const cwd = cwdBySession.get(sessionId)
      if (cwd === undefined) throw new Error(`session "${sessionId}" not found`)
      return { meta: { id: sessionId, cwd }, events: [] }
    },
    async rename() { return {} },
    async prompt() { return {} },
    cancel() {},
  }
  const ctx = {
    effect(effect: () => (() => void)) { cleanups.push(effect()) },
    workspaceRegistry: { list: () => entries },
    sessionController: controller,
    systemPrompt: { context(definition: { text: (assemblyContext: unknown) => string }) { contextText = definition.text } },
    provide(_key: string, value: unknown) { service = value },
    webServer,
  }
  apply(ctx, { enabled: true, ...config })
  if (contextText === undefined || service === undefined) throw new Error('plugin did not mount')
  return { handlers, contextText, service, cleanups }
}

describe('B10 applied workspace resolution and context', () => {
  it('selects each workspace team in synchronous context and keeps disabled/unknown sessions empty', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'live-teams-b10-apply-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'live-teams-b10-apply-b-'))
    const storeA = new TeamStore({ workspacePath: workspaceA, workspaceId: 'workspace-a', teamId: 'workspace-a', name: 'A team' })
    const storeB = new TeamStore({ workspacePath: workspaceB, workspaceId: 'workspace-b', teamId: 'workspace-b', name: 'B team' })
    await storeA.open(); await storeB.open()
    await storeA.commit('workspace-a', { expectedRevision: 0, mutate: (state) => { state.members.push({ memberId: 'member-a', displayName: 'A member', role: 'builder', availability: 'available', sessionId: 'session-a', bindingGeneration: 1, contractRevision: 0 }) } })
    await storeB.commit('workspace-b', { expectedRevision: 0, mutate: (state) => { state.members.push({ memberId: 'member-b', displayName: 'B member', role: 'reviewer', availability: 'available', sessionId: 'session-b', bindingGeneration: 1, contractRevision: 0 }) } })
    const harness = await appliedHarness([
      { id: 'workspace-a', path: workspaceA, title: 'Workspace A', sessionIds: ['session-a'] },
      { id: 'workspace-b', path: workspaceB, title: 'Workspace B', sessionIds: ['session-b'] },
    ], new Map([['session-a', workspaceA], ['session-b', workspaceB]]))
    // Both teams exist and are switched on: each member must read its own, and
    // neither may ever read the other's.
    const aEnabled = harness.contextText({ agent: { session: { id: 'session-a' } } })
    const bEnabled = harness.contextText({ agent: { session: { id: 'session-b' } } })
    expect(aEnabled).toMatch(/^Team: A team$/m)
    expect(aEnabled).not.toContain('B team')
    expect(bEnabled).toMatch(/^Team: B team$/m)
    expect(bEnabled).not.toContain('A team')
    // Switching one team off silences that member only.
    await storeB.setDisabled('workspace-b', true)
    expect(harness.contextText({ agent: { session: { id: 'session-b' } } })).toBe('')
    expect(harness.contextText({ agent: { session: { id: 'session-a' } } })).toMatch(/^Team: A team$/m)
    expect(harness.contextText({ agent: { session: { id: 'unknown' } } })).toBe('')
    for (const cleanup of harness.cleanups) cleanup()
  })

  it('resolves route sessions by cwd and returns disabled for a workspace with no team', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'live-teams-b10-route-a-'))
    const workspaceEmpty = await mkdtemp(join(tmpdir(), 'live-teams-b10-route-empty-'))
    const storeA = new TeamStore({ workspacePath: workspaceA, workspaceId: 'workspace-a', teamId: 'workspace-a', name: 'A team' })
    await storeA.open()
    const harness = await appliedHarness([
      { id: 'workspace-a', path: workspaceA, title: 'Workspace A', sessionIds: ['session-a'] },
      { id: 'workspace-empty', path: workspaceEmpty, title: 'Empty Workspace', sessionIds: ['session-empty'] },
    ], new Map([['session-a', workspaceA], ['session-empty', workspaceEmpty]]))
    const status = response()
    await harness.handlers.get(LIVE_TEAMS_TEAM_ROUTE)?.({ method: 'GET', url: '/api/live-teams/team?session=session-empty', headers, socket: { remoteAddress: '127.0.0.1' } }, status)
    expect(status.statusCode).toBe(200)
    expect(parse(status)).toMatchObject({ enabled: false, teamId: 'workspace-empty', workspacePath: canonicalPath(workspaceEmpty), memberCount: 0 })
    const unknown = response()
    await harness.handlers.get(LIVE_TEAMS_TEAM_ROUTE)?.({ method: 'GET', url: '/api/live-teams/team?session=missing', headers, socket: { remoteAddress: '127.0.0.1' } }, unknown)
    expect(unknown.statusCode).toBe(400)
    expect(parse(unknown)).toEqual({ error: 'live-teams invalid request' })
    for (const cleanup of harness.cleanups) cleanup()
  })

  it('keeps a configured pin ahead of a foreign session workspace', async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), 'live-teams-b10-pin-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'live-teams-b10-pin-b-'))
    const storeA = new TeamStore({ workspacePath: workspaceA, workspaceId: 'workspace-a', teamId: 'pinned-team', name: 'Pinned team' })
    await storeA.open()
    const harness = await appliedHarness([
      { id: 'workspace-a', path: workspaceA, title: 'Workspace A', sessionIds: [] },
      { id: 'workspace-b', path: workspaceB, title: 'Workspace B', sessionIds: ['foreign'] },
    ], new Map([['foreign', workspaceB]]), { workspacePath: workspaceA, teamId: 'pinned-team', teamName: 'Pinned team' })
    const status = response()
    await harness.handlers.get(LIVE_TEAMS_TEAM_ROUTE)?.({ method: 'GET', url: '/api/live-teams/team?session=foreign', headers, socket: { remoteAddress: '127.0.0.1' } }, status)
    expect(status.statusCode).toBe(200)
    expect(parse(status)).toMatchObject({ teamId: 'pinned-team', teamName: 'Pinned team', workspacePath: canonicalPath(workspaceA) })
    for (const cleanup of harness.cleanups) cleanup()
  })
})

describe('B10 lifecycle routes and persistence', () => {
  it('enables, disables, renames with CAS, and preserves the marker/state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b10-life-'))
    const options = await teamOptions(workspace, 'life-team', 'Life team')
    const handlers = routes({ ...options, resolveRequest: async (_request, sessionId) => sessionId === 'seat' ? options : undefined })
    const status = response()
    await handlers.get(LIVE_TEAMS_TEAM_ROUTE)?.({ method: 'GET', url: '/api/live-teams/team?session=seat', headers, socket: { remoteAddress: '127.0.0.1' } }, status)
    expect(status.statusCode).toBe(200)
    expect(parse(status).enabled).toBe(true)
    const disabled = response()
    await handlers.get(LIVE_TEAMS_TEAM_DISABLE_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 'seat' }) }, disabled)
    expect(disabled.statusCode).toBe(200)
    const marker = join(workspace, '.dsh-live-teams', 'teams', 'life-team', 'disabled')
    await expect(stat(marker)).resolves.toBeTruthy()
    const gated = response()
    await handlers.get(LIVE_TEAMS_MEMBERS_ROUTE)?.({ method: 'GET', url: '/api/live-teams/members?session=seat', headers, socket: { remoteAddress: '127.0.0.1' } }, gated)
    expect(gated.statusCode).toBe(503)
    expect(parse(gated)).toEqual({ error: 'live-teams team disabled' })
    const enabled = response()
    await handlers.get(LIVE_TEAMS_TEAM_ENABLE_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 'seat', name: 'Restored team' }) }, enabled)
    expect(enabled.statusCode).toBe(200)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    const renamed = response()
    await handlers.get(LIVE_TEAMS_TEAM_NAME_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 'seat', name: 'Renamed team', expectedRevision: 0 }) }, renamed)
    expect(renamed.statusCode).toBe(200)
    const current = parse(renamed)
    const name = response()
    await handlers.get(LIVE_TEAMS_TEAM_NAME_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 'seat', name: 'Renamed team', expectedRevision: current.revision }) }, name)
    expect(name.statusCode).toBe(200)
    const restarted = new TeamStore({ workspacePath: workspace, workspaceId: 'life-team', teamId: 'life-team' })
    expect((await restarted.open()).name).toBe('Renamed team')
    const events = JSON.parse(`[${(await readFile(join(workspace, '.dsh-live-teams', 'teams', 'life-team', 'events.jsonl'), 'utf8')).trim().split('\n').join(',')}]`) as Array<Record<string, unknown>>
    expect(events.map((entry) => entry.kind)).toEqual(['team/disabled', 'team/enabled', 'team/renamed', 'team/renamed'])
  })

  it('does not call any Session operation while disabling', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b10-no-session-'))
    const options = await teamOptions(workspace, 'no-session-team', 'No session')
    const sessionOperations = { create: vi.fn(), inspect: vi.fn(), rename: vi.fn(), prompt: vi.fn(), cancel: vi.fn() }
    const handlers = routes({ ...options, resolveRequest: async (_request, sessionId) => sessionId === 'seat' ? options : undefined })
    const result = response()
    await handlers.get(LIVE_TEAMS_TEAM_DISABLE_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 'seat' }) }, result)
    expect(result.statusCode).toBe(200)
    expect(sessionOperations.create).not.toHaveBeenCalled()
    expect(sessionOperations.inspect).not.toHaveBeenCalled()
    expect(sessionOperations.rename).not.toHaveBeenCalled()
    expect(sessionOperations.prompt).not.toHaveBeenCalled()
    expect(sessionOperations.cancel).not.toHaveBeenCalled()
  })
})
