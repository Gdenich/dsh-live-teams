import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createMailbox, type MailboxService } from './mailbox.js'
import { createMembershipContextProvider } from './context-provider.js'
import { registerMemberTools, registerMemberToolsIfAvailable, type MemberToolsBinding } from './member-tools.js'
import type { MemberRecord, TeamState } from './team-store.js'

type Call = { readonly sessionId: string; readonly draft: unknown }
type Ack = { readonly messageId: string; readonly recipient: string }
const member: MemberRecord = { memberId: 'm-1', displayName: 'Builder', role: 'engineer', availability: 'available', sessionId: 's-1', bindingGeneration: 3, contractRevision: 5 }
const peer: MemberRecord = { memberId: 'm-2', displayName: 'Reviewer', role: 'reviewer', availability: 'available', sessionId: 's-2', bindingGeneration: 2, contractRevision: 1 }
const team: TeamState = { schemaVersion: 1, revision: 5, teamId: 'team-1', workspaceId: 'workspace-1', workspacePath: '/tmp/team', members: [member, peer], archivedMemberIds: [], createdAt: 1, updatedAt: 2, name: 'Alpha' }
function execution(sessionId: string): ToolRunContext { return { agent: { session: { id: sessionId } } } as unknown as ToolRunContext }
function setup(mailbox: MailboxService, lookup: (sessionId: string) => MemberToolsBinding | undefined = (sessionId) => sessionId === 's-1' ? ({ mailbox, teamId: 'team-1', teamName: 'Alpha', member, team, live: (candidate) => candidate.sessionId !== undefined } satisfies MemberToolsBinding) : undefined) {
  const tools: ToolDefinition[] = []
  registerMemberTools({ register: (tool) => { tools.push(tool); return undefined } }, async (sessionId) => lookup(sessionId))
  return tools
}
function fakeMailbox(calls: Call[], acks: Ack[]): MailboxService {
  return {
    sendFromSession: async (sessionId: string, draft: { to: string; kind: 'message' | 'direction' | 'comment'; content: string; threadId?: string }) => {
      calls.push({ sessionId, draft })
      return {
        message: { id: 'msg-1', teamId: 'team-1', from: 'm-1', to: draft.to, kind: draft.kind, content: draft.content, createdAt: 1 },
        deliveries: [{ id: 'd-1', messageId: 'msg-1', recipient: draft.to, wakePolicy: draft.to === 'human' ? 'never' : 'queue', ackPolicy: draft.to === 'human' ? 'consumption' : 'delivery', state: 'delivered', revision: 1 }],
      }
    },
    acknowledge: async (messageId: string, recipient: string) => {
      if (messageId === 'm-2-delivery') throw new Error('unknown delivery for this member')
      acks.push({ messageId, recipient })
      return { duplicate: acks.length > 1, delivery: { id: 'd-1', messageId, recipient, wakePolicy: 'queue', ackPolicy: 'consumption', state: 'acknowledged', revision: 2, acknowledgedAt: 2 } }
    },
  } as unknown as MailboxService
}

describe('pilot finding F1: the submit tool states its artifact shape', () => {
  // The first live run proved this matters: with an opaque `json` parameter the
  // member invented its own keys, the refusal named a branch it never chose, and it
  // went looking for the error text on disk. A refusal has to name both accepted
  // shapes and what actually arrived.
  function setupWithStore(submitted: unknown[]): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    const binding = {
      mailbox: fakeMailbox([], []),
      teamId: 'team-1',
      teamName: 'Alpha',
      member,
      team,
      live: (candidate: MemberRecord) => candidate.sessionId !== undefined,
      taskStore: { submitTask: async (request: unknown) => { submitted.push(request); return { submission: { id: 'submission-1' } } } },
    } as unknown as MemberToolsBinding
    registerMemberTools({ register: (tool) => { tools.push(tool); return undefined } }, async () => binding, { includeReview: true })
    return tools
  }
  const submit = (tools: ToolDefinition[]) => tools.find((tool) => tool.name === 'live_team_submit') as ToolDefinition

  it('names both shapes and the received keys when the shape is missing', async () => {
    const tools = setupWithStore([])
    const failure = await submit(tools).execute({ taskId: 't-1', summary: 's', artifact: { changed_paths: ['packages/alpha/src/slugify.js'], behavior: 'fixed', checks: [] } }, execution('s-1')).then(() => undefined, (error: Error) => error.message)
    expect(failure).toContain('Accepted shapes')
    expect(failure).toContain('"type":"report","bodyRef"')
    expect(failure).toContain('"type":"files","paths"')
    expect(failure).toContain('changed_paths')
  })

  it('says what a files artifact is missing instead of complaining about an empty path list', async () => {
    const tools = setupWithStore([])
    await expect(submit(tools).execute({ taskId: 't-1', summary: 's', artifact: { type: 'files', paths: [] } }, execution('s-1'))).rejects.toThrow(/non-empty "paths"/u)
    await expect(submit(tools).execute({ taskId: 't-1', summary: 's', artifact: { type: 'report' } }, execution('s-1'))).rejects.toThrow(/needs a string "bodyRef"/u)
  })

  it('still submits a well-formed artifact', async () => {
    const submitted: unknown[] = []
    const tools = setupWithStore(submitted)
    const result = await submit(tools).execute({ taskId: 't-1', summary: 'done', artifact: { type: 'files', paths: ['packages/alpha/src/slugify.js'] }, checks: [{ command: 'npm test', status: 'passed' }] }, execution('s-1'))
    expect(result).toEqual({ submission: { id: 'submission-1' } })
    expect(submitted[0]).toMatchObject({ artifact: { type: 'files', paths: ['packages/alpha/src/slugify.js'] } })
  })
})

describe('B13 member tools', () => {
  it('registers exactly four tools with frozen names and schemas', () => {
    const tools = setup(fakeMailbox([], []))
    expect(tools.map((tool) => tool.name)).toEqual(['live_team_send', 'live_team_ack_message', 'live_team_context', 'live_team_status'])
    // `kind` is optional with a default and accepts `report` as a synonym for `message` (F13);
    // everything else about the schema is frozen.
    expect(tools[0]?.parameters).toMatchObject({ type: 'object', properties: { to: { type: 'string' }, kind: { type: 'string', enum: ['message', 'direction', 'comment', 'report'] }, content: { type: 'string' }, threadId: { type: 'string' } } })
    expect(JSON.stringify(tools[0]?.parameters)).not.toContain('"required":["to","kind"')
    expect(tools[1]?.parameters).toMatchObject({ type: 'object', properties: { messageId: { type: 'string' } } })
    expect(tools[2]?.parameters).toMatchObject({ type: 'object', properties: {} })
    expect(tools[3]?.parameters).toMatchObject({ type: 'object', properties: {} })
    expect(tools[0]?.output.schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('does not register when tools service is absent', () => {
    expect(registerMemberToolsIfAvailable(undefined, async () => undefined)).toBe(false)
  })

  it('derives the sender from exec agent session and cannot use a sender argument', async () => {
    const calls: Call[] = []
    const tools = setup(fakeMailbox(calls, []))
    const result = await tools[0]!.execute({ to: 'human', kind: 'message', content: 'hello', from: 'human' }, execution('s-1'))
    expect(result).toMatchObject({ accepted: true, delivered: 1, inbox: 0, pending: 0, failed: 0, deliveries: [{ recipient: 'human', name: 'human', state: 'delivered', outcome: 'delivered' }] })
    expect(result).not.toHaveProperty('sent')
    expect(calls[0]).toMatchObject({ sessionId: 's-1', draft: { to: 'human', content: 'hello' } })
  })

  it('rejects an unbound Session and never sends', async () => {
    const calls: Call[] = []
    const tools = setup(fakeMailbox(calls, []), () => undefined)
    await expect(tools[0]!.execute({ to: 'm-2', kind: 'message', content: 'nope' }, execution('outsider'))).rejects.toThrow(/not an active member/)
    expect(calls).toHaveLength(0)
  })

  it('acknowledges only the calling member recipient', async () => {
    const acks: Ack[] = []
    const tools = setup(fakeMailbox([], acks))
    await tools[1]!.execute({ messageId: 'msg-1' }, execution('s-1'))
    expect(acks).toEqual([{ messageId: 'msg-1', recipient: 'm-1' }])
  })

  it('cannot acknowledge another member delivery', async () => {
    const acks: Ack[] = []
    const tools = setup(fakeMailbox([], acks))
    await expect(tools[1]!.execute({ messageId: 'm-2-delivery' }, execution('s-1'))).rejects.toThrow(/unknown delivery/)
    expect(acks).toEqual([])
  })

  it('repeating acknowledgement remains a successful no-op', async () => {
    const acks: Ack[] = []
    const tools = setup(fakeMailbox([], acks))
    await expect(tools[1]!.execute({ messageId: 'msg-1' }, execution('s-1'))).resolves.toEqual({ acknowledged: true, messageId: 'msg-1' })
    await expect(tools[1]!.execute({ messageId: 'msg-1' }, execution('s-1'))).resolves.toEqual({ acknowledged: true, messageId: 'msg-1' })
    expect(acks).toEqual([{ messageId: 'msg-1', recipient: 'm-1' }, { messageId: 'msg-1', recipient: 'm-1' }])
  })

  it('returns bounded context and status for the calling member', async () => {
    const tools = setup(fakeMailbox([], []))
    await expect(tools[2]!.execute({}, execution('s-1'))).resolves.toMatchObject({ teamName: 'Alpha', memberName: 'Builder', members: [{ memberId: 'm-1', name: 'Builder' }, { memberId: 'm-2', name: 'Reviewer' }] })
    await expect(tools[3]!.execute({}, execution('s-1'))).resolves.toMatchObject({ memberId: 'm-1', teamId: 'team-1', bindingGeneration: 3, contractRevision: 5, live: true })
  })

  it('reports each delivery truthfully and renders undelivered recipients explicitly', async () => {
    const mailbox = fakeMailbox([], [])
    mailbox.sendFromSession = async () => ({
      message: { id: 'msg-failed', teamId: 'team-1', from: 'm-1', to: 'm-2', kind: 'message', content: 'hello', createdAt: 1 },
      deliveries: [{ id: 'd-failed', messageId: 'msg-failed', recipient: 'm-2', wakePolicy: 'queue', ackPolicy: 'delivery', state: 'failed', failure: 'recipient has no current session binding', revision: 2 }],
    })
    const tools = setup(mailbox)
    const send = tools[0]!
    const result = await send.execute({ to: 'm-2', kind: 'message', content: 'hello' }, execution('s-1'))
    expect(result).toEqual({ accepted: true, messageId: 'msg-failed', delivered: 0, inbox: 0, pending: 0, failed: 1, deliveries: [{ recipient: 'm-2', name: 'Reviewer', state: 'failed', outcome: 'failed', failure: 'recipient has no current session binding' }] })
    expect(result).not.toHaveProperty('sent')
    const rendered = send.output.render?.({}, result as Parameters<NonNullable<typeof send.output.render>>[1])
    expect(JSON.stringify(rendered)).toContain('Nothing was delivered to: Reviewer (failed: recipient has no current session binding)')
  })

  it('reports human inbox storage without a warning in the tool output', async () => {
    const mailbox = fakeMailbox([], [])
    mailbox.sendFromSession = async () => ({
      message: { id: 'msg-inbox', teamId: 'team-1', from: 'm-1', to: 'human', kind: 'message', content: 'report', createdAt: 1 },
      deliveries: [{ id: 'd-inbox', messageId: 'msg-inbox', recipient: 'human', wakePolicy: 'never', ackPolicy: 'consumption', state: 'stored', revision: 1 }],
    })
    const tools = setup(mailbox)
    const send = tools[0]!
    const result = await send.execute({ to: 'human', kind: 'message', content: 'report' }, execution('s-1'))
    expect(result).toEqual({ accepted: true, messageId: 'msg-inbox', delivered: 0, inbox: 1, pending: 0, failed: 0, deliveries: [{ recipient: 'human', name: 'human', state: 'stored', outcome: 'inbox' }] })
    const rendered = send.output.render?.({}, result as Parameters<NonNullable<typeof send.output.render>>[1])
    expect(JSON.stringify(rendered)).toContain('Stored in the human inbox (waits for the human).')
    expect(JSON.stringify(rendered)).not.toContain('Nothing was delivered')
  })

  it('accepts `report` as a synonym for `message` and defaults an omitted kind (F13)', async () => {
    const calls: { sessionId: string; draft: { kind: string; content: string; to: string } }[] = []
    const tools = setup(fakeMailbox(calls as never, []))
    const send = tools[0]!
    await send.execute({ to: 'human', kind: 'report', content: 'what I did' }, execution('s-1'))
    expect(calls[0]?.draft.kind).toBe('message')
    await send.execute({ to: 'human', content: 'and nothing else' }, execution('s-1'))
    expect(calls[1]?.draft.kind).toBe('message')
    // The vocabulary keeps its meaning: a real direction is still a direction.
    await send.execute({ to: 'm-2', kind: 'direction', content: 'do this' }, execution('s-1'))
    expect(calls[2]?.draft.kind).toBe('direction')
  })

  it('reports a comment to an unbound member as inbox context', async () => {
    const mailbox = fakeMailbox([], [])
    mailbox.sendFromSession = async () => ({
      message: { id: 'msg-comment-inbox', teamId: 'team-1', from: 'm-1', to: 'm-2', kind: 'comment', content: 'context', createdAt: 1 },
      deliveries: [{ id: 'd-comment-inbox', messageId: 'msg-comment-inbox', recipient: 'm-2', wakePolicy: 'never', ackPolicy: 'consumption', state: 'stored', revision: 1 }],
    })
    const result = await setup(mailbox)[0]!.execute({ to: 'm-2', kind: 'comment', content: 'context' }, execution('s-1'))
    expect(result).toMatchObject({ delivered: 0, inbox: 1, pending: 0, failed: 0, deliveries: [{ recipient: 'm-2', name: 'Reviewer', state: 'stored', outcome: 'inbox' }] })
  })

  it('reports a message to an unbound member as failed with its reason', async () => {
    const mailbox = fakeMailbox([], [])
    mailbox.sendFromSession = async () => ({
      message: { id: 'msg-message-failed', teamId: 'team-1', from: 'm-1', to: 'm-2', kind: 'message', content: 'urgent', createdAt: 1 },
      deliveries: [{ id: 'd-message-failed', messageId: 'msg-message-failed', recipient: 'm-2', wakePolicy: 'queue', ackPolicy: 'delivery', state: 'failed', failure: 'recipient has no current session binding', revision: 2 }],
    })
    const result = await setup(mailbox)[0]!.execute({ to: 'm-2', kind: 'message', content: 'urgent' }, execution('s-1'))
    expect(result).toMatchObject({ delivered: 0, inbox: 0, pending: 0, failed: 1, deliveries: [{ recipient: 'm-2', name: 'Reviewer', state: 'failed', outcome: 'failed', failure: 'recipient has no current session binding' }] })
  })

  it('keeps all outcome counters additive in the tool result', async () => {
    const mailbox = fakeMailbox([], [])
    mailbox.sendFromSession = async () => ({
      message: { id: 'msg-mixed', teamId: 'team-1', from: 'm-1', to: 'team', kind: 'message', content: 'mixed', createdAt: 1 },
      deliveries: [
        { id: 'd-delivered', messageId: 'msg-mixed', recipient: 'm-1', wakePolicy: 'queue', ackPolicy: 'delivery', state: 'delivered', revision: 1 },
        { id: 'd-inbox', messageId: 'msg-mixed', recipient: 'human', wakePolicy: 'never', ackPolicy: 'consumption', state: 'stored', revision: 1 },
        { id: 'd-pending', messageId: 'msg-mixed', recipient: 'm-2', wakePolicy: 'queue', ackPolicy: 'delivery', state: 'stored', revision: 1 },
        { id: 'd-failed', messageId: 'msg-mixed', recipient: 'm-3', wakePolicy: 'queue', ackPolicy: 'delivery', state: 'failed', failure: 'bridge refused', revision: 2 },
      ],
    })
    const result = await setup(mailbox)[0]!.execute({ to: 'team', kind: 'message', content: 'mixed' }, execution('s-1'))
    expect(result).toMatchObject({ delivered: 1, inbox: 1, pending: 1, failed: 1 })
    const counters = result as { delivered: number; inbox: number; pending: number; failed: number; deliveries: unknown[] }
    expect(counters.delivered + counters.inbox + counters.pending + counters.failed).toBe(counters.deliveries.length)
  })

  it('resolves a peer by display name and exact id through the same send tool', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b16-member-'))
    try {
      const command = { commandId: 'c-1', idempotencyKey: 'k', sessionId: 's-2', bindingGeneration: 1, mode: 'queue' as const, requestId: 'r-1', state: 'admitted' as const, receipt: 'accepted', failureCode: undefined, failureDetail: undefined, revision: 1 }
      const recipients = [
        { memberId: 'm-1', displayName: 'Builder', sessionId: 's-1', bindingGeneration: 1, active: true },
        { memberId: 'm-2', displayName: 'Reviewer', sessionId: 's-2', bindingGeneration: 1, active: true },
      ]
      const mailbox = createMailbox({ workspacePath, teamId: 'team-1', queue: { admit: async () => ({ record: command, duplicate: false }), dispatch: async () => command }, listRecipients: async () => recipients, resolveSessionSender: (sessionId) => sessionId === 's-1' ? 'm-1' : undefined })
      const tools = setup(mailbox)
      const byName = await tools[0]!.execute({ to: ' reviewer ', kind: 'message', content: 'by name' }, execution('s-1'))
      const byId = await tools[0]!.execute({ to: 'm-2', kind: 'message', content: 'by id' }, execution('s-1'))
      expect(byName).toMatchObject({ accepted: true, delivered: 1, inbox: 0, pending: 0, failed: 0, deliveries: [{ recipient: 'm-2', name: 'Reviewer', state: 'delivered', outcome: 'delivered' }] })
      expect(byId).toMatchObject({ accepted: true, delivered: 1, inbox: 0, pending: 0, failed: 0, deliveries: [{ recipient: 'm-2', name: 'Reviewer', state: 'delivered', outcome: 'delivered' }] })
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('flips the context policy line exactly with mounted tools', () => {
    const store = { memberBySessionSync: () => ({ ...member }) }
    const absent = createMembershipContextProvider({ store, teamId: 'team-1' }).text({ agent: { session: { id: 's-1' } } })
    const mounted = createMembershipContextProvider({ store, teamId: 'team-1', formalToolsAvailable: true }).text({ agent: { session: { id: 's-1' } } })
    expect(absent).toContain('Team-state changes are not available to you')
    expect(absent).not.toContain('Use live_team_* tools')
    expect(mounted).toContain('Use live_team_* tools for formal state changes.')
    expect(mounted).not.toContain('Team-state changes are not available to you')
  })

  it('delivers peer and human attribution through the mailbox transport', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-b13-'))
    try {
      const contents: string[] = []
      const queue = { admit: async (request: { content: readonly unknown[]; idempotencyKey: string; sessionId: string; bindingGeneration: number; mode: 'queue' | 'steer' }) => { contents.push(String((request.content[0] as { text?: unknown }).text)); return { duplicate: false, record: { commandId: request.idempotencyKey, ...request, requestId: request.idempotencyKey, state: 'admitted' as const, receipt: undefined, failureCode: undefined, failureDetail: undefined, revision: 1 } } }, dispatch: async (id: string) => ({ commandId: id, idempotencyKey: id, sessionId: 's-1', bindingGeneration: 1, mode: 'queue' as const, requestId: id, state: 'admitted' as const, receipt: undefined, failureCode: undefined, failureDetail: undefined, revision: 1 }) }
      const mailbox = createMailbox({ workspacePath, teamId: 'team-1', queue, listRecipients: async () => [{ memberId: 'm-1', displayName: 'Builder', sessionId: 's-1', bindingGeneration: 1, active: true }], resolveSessionSender: (sessionId) => sessionId === 's-1' ? 'm-1' : undefined })
      await mailbox.sendFromSession('s-1', { to: 'm-1', kind: 'message', content: 'peer' })
      await mailbox.sendFromHuman({ to: 'm-1', kind: 'direction', content: 'human' })
      expect(contents).toContain('Peer message from Builder (message): peer')
      expect(contents).toContain('Human instruction (direction): human')
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })
})

