import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createMembershipContextProvider, DEFAULT_BRIEFING, renderMembership } from './context-provider.js'
import { MEMBER_TOOL_NAMES, assertToolRolesComplete, toolsForRole } from './member-tools.js'
import { registerMemberTools } from './member-tools.js'
import { TeamStore, type TeamState } from './team-store.js'
import { LIVE_TEAMS_TEAM_LEAD_ROUTE, registerLiveTeamsRoutes, type LiveTeamsResponse, type LiveTeamsWebServer } from './routes.js'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

function state(): TeamState {
  return { schemaVersion: 1, revision: 1, teamId: 'team', workspaceId: 'ws', workspacePath: '/tmp', members: [
    { memberId: 'lead', displayName: 'Lead', role: 'lead', availability: 'available', sessionId: 's-lead', bindingGeneration: 1, contractRevision: 1 },
    { memberId: 'worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 's-worker', bindingGeneration: 1, contractRevision: 1 },
  ], archivedMemberIds: [], createdAt: 1, updatedAt: 1, leadMemberId: 'lead' }
}
function providerFor(workspacePath: string, current: TeamState) {
  return createMembershipContextProvider({ workspacePath, teamId: current.teamId, store: {
    memberBySessionSync: (_teamId, sessionId) => current.members.find((member) => member.sessionId === sessionId),
    teamStateSync: () => current,
  } })
}
function execution(sessionId: string): ToolRunContext { return { agent: { session: { id: sessionId } } } as unknown as ToolRunContext }
function response(): LiveTeamsResponse & { body?: string; headers: Record<string, string> } {
  const value = { statusCode: 0, body: undefined as string | undefined, headers: {} as Record<string, string> }
  return { get statusCode() { return value.statusCode }, set statusCode(next) { value.statusCode = next }, headers: value.headers, setHeader(name, next) { value.headers[name] = next }, end(body) { value.body = body } }
}
const request = (method: string, body?: unknown) => ({ method, headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

describe('B17 operating frame', () => {
  it('renders live roster changes without changing the briefing', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b17-'))
    try {
      await mkdir(join(workspacePath, '.dsh-live-teams'), { recursive: true }); await writeFile(join(workspacePath, '.dsh-live-teams', 'BRIEF.md'), 'Order text')
      const current = state(); const provider = providerFor(workspacePath, current)
      const first = provider.text({ agent: { session: { id: 's-worker' } } })
      current.members[1]!.availability = 'paused'; current.members.push({ memberId: 'new', displayName: 'New', role: 'researcher', availability: 'available', sessionId: 's-new', bindingGeneration: 1, contractRevision: 0 })
      const second = provider.text({ agent: { session: { id: 's-worker' } } })
      expect(first).toContain('Order text'); expect(first).toContain('available'); expect(second).toContain('paused'); expect(second).toContain('New (researcher)')
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })
  it('keeps frame before volatile counters and caps briefing explicitly', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b17-'))
    try {
      await mkdir(join(workspacePath, '.dsh-live-teams'), { recursive: true }); await writeFile(join(workspacePath, '.dsh-live-teams', 'BRIEF.md'), 'x'.repeat(5000))
      const rendered = providerFor(workspacePath, state()).text({ agent: { session: { id: 's-worker' } } })
      expect(rendered).toContain('briefing truncated'); expect(Array.from(rendered).length).toBeLessThan(9000); expect(rendered.indexOf('Who is on this team now')).toBeLessThan(rendered.indexOf('Binding generation'))
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })
  it('resolves lead from state, single lead role, or not set', () => {
    const current = state(); expect(renderMembership(current.members[1]!, { teamId: 'team', teamState: current })).toContain('Lead: Lead')
    delete current.leadMemberId; expect(renderMembership(current.members[1]!, { teamId: 'team', teamState: current })).toContain('Lead: Lead')
    current.members[0]!.role = 'builder'; expect(renderMembership(current.members[1]!, { teamId: 'team', teamState: current })).toContain('Lead: not set')
  })
  it('clears leadMemberId when the lead member is removed', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b17-store-'))
    try { const store = new TeamStore({ workspacePath, workspaceId: 'ws', teamId: 'team' }); const opened = await store.open(); await store.commit('team', { expectedRevision: opened.revision, mutate: (next) => { next.members.push(...state().members); next.leadMemberId = 'lead' } }); const current = await store.open(); const removed = await store.removeMember('team', 'lead', current.revision); expect(removed.state.leadMemberId).toBeUndefined() } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })
  it('caps roster at 20 members and states omission', () => {
    const current = state(); current.members = Array.from({ length: 22 }, (_, index) => ({ memberId: `m-${index}`, displayName: `Member ${index}`, role: 'worker', availability: 'available', sessionId: `s-${index}`, bindingGeneration: 1, contractRevision: 0 }));
    const rendered = renderMembership(current.members[0]!, { teamId: 'team', teamState: current }); expect(rendered).toContain('2 members omitted'); expect(rendered.match(/^-/gmu)?.length).toBe(21)
  })
  it('uses the built-in default for missing and unreadable briefings', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b17-brief-')); const current = state()
    try { const provider = providerFor(workspacePath, current); expect(provider.text({ agent: { session: { id: 's-worker' } } })).toContain(DEFAULT_BRIEFING); await mkdir(join(workspacePath, '.dsh-live-teams'), { recursive: true }); await mkdir(join(workspacePath, '.dsh-live-teams', 'BRIEF.md')); expect(provider.text({ agent: { session: { id: 's-worker' } } })).toContain(DEFAULT_BRIEFING) } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })
  it('registers the two B17 tools after the existing member tools', () => {
    const tools: ToolDefinition[] = []; registerMemberTools({ register: (tool) => { tools.push(tool); return undefined } }, async () => undefined, true); expect(tools.map((tool) => tool.name)).toEqual(['live_team_send', 'live_team_ack_message', 'live_team_context', 'live_team_brief', 'live_team_member_note', 'live_team_status'])
  })
  it('refuses non-lead authoring and audits each lead write exactly once', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b17-tools-')); const current = state(); const audit: unknown[] = []
    try { await mkdir(join(workspacePath, '.dsh-live-teams'), { recursive: true }); const tools: ToolDefinition[] = []; const binding = (sessionId: string) => ({ mailbox: {} as never, teamId: 'team', teamName: 'Team', member: current.members.find((entry) => entry.sessionId === sessionId)!, team: current, workspacePath, live: () => true, appendAudit: async (event: unknown) => { audit.push(event) } }); registerMemberTools({ register: (tool) => { tools.push(tool); return undefined } }, async (sessionId) => binding(sessionId), true); const brief = tools.find((tool) => tool.name === 'live_team_brief')!; const note = tools.find((tool) => tool.name === 'live_team_member_note')!; await expect(brief.execute({ action: 'update', text: 'x' }, execution('s-worker'))).rejects.toThrow(/briefing is owned by the lead/u); await expect(note.execute({ memberId: 'worker', note: 'x' }, execution('s-worker'))).rejects.toThrow(/briefing is owned by the lead/u); await brief.execute({ action: 'update', text: 'x' }, execution('s-lead')); await note.execute({ memberId: 'worker', note: 'does work' }, execution('s-lead')); expect(audit.filter((entry) => (entry as { kind?: string }).kind === 'briefing/updated')).toHaveLength(1); expect(audit.filter((entry) => (entry as { kind?: string }).kind === 'member/note')).toHaveLength(1) } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })
  it('lead route sets lead, audits once, and refuses a stranger with 400', async () => {
    const current = state(); const audit: unknown[] = []; const handlers = new Map<string, (request: never, response: LiveTeamsResponse) => unknown>(); const server: LiveTeamsWebServer = { port: 43120, register(route) { handlers.set(route.path, route.handler as never); return () => {} } }; registerLiveTeamsRoutes({ webServer: server }, { teamId: 'team', workspacePath: '/tmp', readState: async () => current, setLead: async (memberId) => { current.leadMemberId = memberId; return { state: current, leadMemberId: memberId } }, appendAudit: async (event) => { audit.push(event) } }); const handler = handlers.get(LIVE_TEAMS_TEAM_LEAD_ROUTE)!; const success = response(); await handler(request('POST', { sessionId: 's-worker', memberId: 'worker' }) as never, success); expect(success.statusCode).toBe(200); expect(audit).toHaveLength(1); const stranger = response(); await handler(request('POST', { sessionId: 's-worker', memberId: 'stranger' }) as never, stranger); expect(stranger.statusCode).toBe(400)
  })
})

describe('the context names the tools of the role', () => {
  it('lists what belongs to the member and what belongs to others, from one complete map', () => {
    assertToolRolesComplete()
    const builder = toolsForRole('builder')
    expect(builder.mine).toContain('live_team_submit')
    expect(builder.mine).not.toContain('live_team_create_task')
    expect(builder.notMine).toEqual(expect.arrayContaining(['live_team_create_task', 'live_team_review', 'live_team_revoke_task', 'live_team_accept_task']))
    const lead = toolsForRole('lead')
    expect(lead.notMine).toEqual(['live_team_review'])
    expect(lead.mine).toEqual(expect.arrayContaining(['live_team_create_task', 'live_team_revoke_task', 'live_team_dispatch']))
    const reviewer = toolsForRole('reviewer')
    expect(reviewer.mine).toContain('live_team_review')
    expect(reviewer.notMine).toEqual(expect.arrayContaining(['live_team_create_task', 'live_team_accept_task']))
    // Verifier judges work too; the role files are craft, the capability is the same.
    expect(toolsForRole('verifier').mine).toContain('live_team_review')
    // Every tool has exactly one home.
    const all = [...builder.mine, ...builder.notMine].sort()
    expect(all).toEqual([...MEMBER_TOOL_NAMES].sort())
  })
})
