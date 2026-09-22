import { mkdtemp, rm} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createMailbox, type MailboxService } from './mailbox.js'
import { createMembershipContextProvider } from './context-provider.js'
import { TeamStore, type TeamState } from './team-store.js'
import { registerMemberTools, type MemberToolsBinding } from './member-tools.js'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ERROR_CODES, LiveTeamsError } from './errors.js'

const lead = { memberId: 'lead', displayName: 'Lead', role: 'lead', availability: 'available', sessionId: 's-lead', bindingGeneration: 1, contractRevision: 0 }
const worker = { memberId: 'worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 's-worker', bindingGeneration: 1, contractRevision: 0 }
const peer = { memberId: 'peer', displayName: 'Peer', role: 'reviewer', availability: 'available', sessionId: 's-peer', bindingGeneration: 1, contractRevision: 0 }
function state(overrides: Partial<TeamState> = {}): TeamState {
  return { schemaVersion: 1, revision: 1, teamId: 'team', workspaceId: 'ws', workspacePath: '/tmp', members: [lead, worker, peer], archivedMemberIds: [], createdAt: 1, updatedAt: 1, leadMemberId: 'lead', ...overrides }
}
function execution(sessionId: string): ToolRunContext { return { agent: { session: { id: sessionId } } } as unknown as ToolRunContext }
function commandQueue() {
  return {
    admit: async (request: { idempotencyKey: string; sessionId: string; bindingGeneration: number; mode: 'queue' | 'steer' }) => ({ duplicate: false, record: { commandId: request.idempotencyKey, ...request, requestId: request.idempotencyKey, state: 'admitted' as const, receipt: 'ok', failureCode: undefined, failureDetail: undefined, revision: 1 } }),
    dispatch: async (id: string) => ({ commandId: id, idempotencyKey: id, sessionId: 's-lead', bindingGeneration: 1, mode: 'queue' as const, requestId: id, state: 'admitted' as const, receipt: 'ok', failureCode: undefined, failureDetail: undefined, revision: 1 }),
  }
}
async function mailboxFor(current: TeamState, audit: unknown[] = [], autoDeliver = false): Promise<{ mailbox: MailboxService; workspacePath: string }> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b18-'))
  const mailbox = createMailbox({
    workspacePath, teamId: 'team', queue: commandQueue(), autoDeliver,
    listRecipients: async () => current.members.map((member) => ({ memberId: member.memberId, displayName: member.displayName, ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }), bindingGeneration: member.bindingGeneration, active: true })),
    resolveSessionSender: (sessionId) => current.members.find((member) => member.sessionId === sessionId)?.memberId,
    authorize: ({ from, to }) => {
      if (from === 'human' || from === 'scheduler') return
      const sender = current.members.find((member) => member.memberId === from)
      const leadId = current.leadMemberId
      if (sender !== undefined && (to === sender.memberId || to === leadId || sender.memberId === leadId || current.contactGrants?.some((grant) => grant.from === sender.memberId && grant.to === to) === true)) return
      const target = to === 'human' || to === 'team' ? to : current.members.find((member) => member.memberId === to)?.displayName ?? to
      if (leadId === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `Not permitted to address ${target}: this team has no lead. Ask the human to set one in the Team tab.`)
      throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `Not permitted to address ${target}: peer contact is granted by your lead. Send this to your lead instead — the lead holds the project context and decides whether a conversation with ${target} is warranted.`)
    },
    appendAudit: async (event) => { audit.push(event) },
  })
  return { mailbox, workspacePath }
}

describe('B18 enforced contact policy', () => {
  it('allows lead, self, and human paths while refusing peer/team/human without a grant', async () => {
    const current = state(); const audit: unknown[] = []; const { mailbox, workspacePath } = await mailboxFor(current, audit)
    try {
      await expect(mailbox.sendFromSession('s-worker', { to: 'lead', kind: 'message', content: 'lead' })).resolves.toBeDefined()
      await expect(mailbox.sendFromSession('s-worker', { to: 'worker', kind: 'message', content: 'self' })).resolves.toBeDefined()
      for (const to of ['peer', 'team', 'human']) await expect(mailbox.sendFromSession('s-worker', { to, kind: 'message', content: to })).rejects.toThrow(/Send this to your lead instead/u)
      await expect(mailbox.sendFromSession('s-lead', { to: 'human', kind: 'message', content: 'lead can' })).resolves.toBeDefined()
      await expect(mailbox.sendFromSession('s-lead', { to: 'team', kind: 'message', content: 'lead can' })).resolves.toBeDefined()
      await expect(mailbox.sendFromHuman({ to: 'peer', kind: 'message', content: 'human can' })).resolves.toBeDefined()
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('refusal persists neither message nor delivery and appends no audit', async () => {
    const current = state(); const audit: unknown[] = []; const { mailbox, workspacePath } = await mailboxFor(current, audit)
    try {
      await expect(mailbox.sendFromSession('s-worker', { to: 'peer', kind: 'message', content: 'blocked' })).rejects.toThrow(/Peer/u)
      expect(await mailbox.listMessages()).toEqual([])
      expect(await mailbox.listDeliveries()).toEqual([])
      expect(audit).toEqual([])
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('grant is exact and remove restores refusal', async () => {
    const current = state({ contactGrants: [{ from: 'worker', to: 'peer', grantedBy: 'lead', at: 1 }] }); const { mailbox, workspacePath } = await mailboxFor(current)
    try {
      await expect(mailbox.sendFromSession('s-worker', { to: 'peer', kind: 'message', content: 'allowed' })).resolves.toBeDefined()
      await expect(mailbox.sendFromSession('s-worker', { to: 'human', kind: 'message', content: 'not allowed' })).rejects.toThrow(/lead/u)
      current.contactGrants = []
      await expect(mailbox.sendFromSession('s-worker', { to: 'peer', kind: 'message', content: 'revoked' })).rejects.toThrow(/lead/u)
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('missing lead explains that the human must set one in the Team tab', async () => {
    const current = state({ members: [worker, peer] }); delete current.leadMemberId; const { mailbox, workspacePath } = await mailboxFor(current)
    try { await expect(mailbox.sendFromSession('s-worker', { to: 'peer', kind: 'message', content: 'blocked' })).rejects.toThrow(/no lead.*Team tab/u) } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('cascades grants in both directions when a member is removed', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b18-store-'))
    try {
      const store = new TeamStore({ workspacePath, workspaceId: 'ws', teamId: 'team' }); const opened = await store.open()
      await store.commit('team', { expectedRevision: opened.revision, mutate: (next) => { next.members.push(lead, worker, peer); next.leadMemberId = 'lead'; next.contactGrants = [{ from: 'worker', to: 'peer', grantedBy: 'lead', at: 1 }, { from: 'peer', to: 'worker', grantedBy: 'lead', at: 2 }, { from: 'worker', to: 'human', grantedBy: 'lead', at: 3 }] } })
      const current = await store.open(); const removed = await store.removeMember('team', 'peer', current.revision)
      expect(removed.state.contactGrants).toEqual([{ from: 'worker', to: 'human', grantedBy: 'lead', at: 3 }])
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('renders the permitted path before a send and updates after a grant', () => {
    const current = state(); const provider = createMembershipContextProvider({ teamId: 'team', store: { memberBySessionSync: (_id, sessionId) => current.members.find((member) => member.sessionId === sessionId), teamStateSync: () => current } })
    expect(provider.text({ agent: { session: { id: 's-worker' } } })).toContain('You may address: Lead; no peer contact granted')
    current.contactGrants = [{ from: 'worker', to: 'peer', grantedBy: 'lead', at: 1 }]
    expect(provider.text({ agent: { session: { id: 's-worker' } } })).toContain('You may address: Lead; Peer')
  })

  it('allows every member to list own grants, but only lead changes them', async () => {
    const current = state({ contactGrants: [{ from: 'worker', to: 'peer', grantedBy: 'lead', at: 1 }] }); const tools: ToolDefinition[] = []
    const update = async (from: string, to: string, _action: 'add' | 'remove', actor: string) => ({ grants: [{ from, to, grantedBy: actor, at: 1 }] })
    const binding = (sessionId: string): MemberToolsBinding => ({ mailbox: {} as MailboxService, teamId: 'team', teamName: 'Team', member: current.members.find((member) => member.sessionId === sessionId)!, team: current, live: () => true, updateContactGrant: update })
    registerMemberTools({ register: (tool) => { tools.push(tool); return undefined } }, async (sessionId) => binding(sessionId), true, true)
    const grant = tools.find((tool) => tool.name === 'live_team_grant')!
    await expect(grant.execute({ action: 'list' }, execution('s-worker'))).resolves.toMatchObject({ grants: [{ from: 'worker', to: 'peer' }] })
    await expect(grant.execute({ action: 'add', memberId: 'worker', allow: 'human' }, execution('s-worker'))).rejects.toThrow(/only the lead/u)
    await expect(grant.execute({ action: 'add', memberId: 'worker', allow: 'human' }, execution('s-lead'))).resolves.toMatchObject({ grants: [{ to: 'human' }] })
  })
})
