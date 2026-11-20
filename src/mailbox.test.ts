import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMailbox, messageDeliveryOutcome, type CommandQueueLike, type MessageDeliveryState, type MessageDraft, type MailboxAuditEvent, type MailboxRecipient, type MessageWakePolicy } from './mailbox.js'
import { ERROR_CODES, LiveTeamsError } from './errors.js'

type TestCommand = {
  commandId: string
  idempotencyKey: string
  sessionId: string
  bindingGeneration: number
  mode: 'queue' | 'steer'
  requestId: string
  state: 'pending' | 'leased' | 'admitted' | 'applied' | 'failed'
  receipt: string | undefined
  failureCode: string | undefined
  failureDetail: string | undefined
  revision: number
}

function command(id: string, request: { idempotencyKey: string; sessionId: string; bindingGeneration: number; mode: 'queue' | 'steer' }): TestCommand {
  return { commandId: id, ...request, requestId: `team-1:${request.idempotencyKey}`, state: 'admitted', receipt: 'accepted', failureCode: undefined, failureDetail: undefined, revision: 1 }
}

async function mailboxOf(options: {
  recipients?: readonly MailboxRecipient[]
  autoDeliver?: boolean
  now?: () => number
  leaseMs?: number
  admit?: CommandQueueLike['admit']
  dispatch?: CommandQueueLike['dispatch']
  audit?: (event: MailboxAuditEvent) => Promise<void>
} = {}) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-mailbox-'))
  const calls: TestCommand[] = []
  const keys = new Map<string, TestCommand>()
  const queue: CommandQueueLike = {
    admit: options.admit ?? (async (request) => {
      const existing = keys.get(request.idempotencyKey)
      if (existing !== undefined) return { record: existing, duplicate: true }
      const entry = command(`command-${String(keys.size + 1)}`, request)
      keys.set(request.idempotencyKey, entry)
      calls.push(entry)
      return { record: entry, duplicate: false }
    }),
    dispatch: options.dispatch ?? (async (commandId) => {
      const entry = calls.find((candidate) => candidate.commandId === commandId)
      if (entry === undefined) throw new Error('missing test command')
      return entry
    }),
  }
  const mailbox = createMailbox({
    workspacePath,
    teamId: 'team-1',
    queue,
    listRecipients: async () => options.recipients ?? [{ memberId: 'm-1', displayName: 'Builder', sessionId: 's-1', bindingGeneration: 1, active: true }],
    resolveSessionSender: async (sessionId) => sessionId === 's-1' ? 'm-1' : undefined,
    ...(options.audit === undefined ? {} : { appendAudit: options.audit }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.autoDeliver === undefined ? {} : { autoDeliver: options.autoDeliver }),
  })
  return { workspacePath, mailbox, calls, queue }
}

const message = (overrides: Partial<MessageDraft> = {}): MessageDraft => ({ to: 'm-1', kind: 'message', content: 'hello', ...overrides })

describe('quiet broadcast and concurrent delivery', () => {
  it('allows the original delivery to finish while concurrent calls return a pending receipt', async () => {
    let release!: () => void; let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    let admitted: TestCommand | undefined
    const f = await mailboxOf({ autoDeliver: false, admit: async request => { admitted = command('held-command', request); return { record: admitted, duplicate: false } }, dispatch: async () => { entered(); await gate; return admitted! } })
    try {
      const sent = await f.mailbox.sendFromHuman(message())
      const first = f.mailbox.deliver(sent.deliveries[0]!.id)
      await ready
      expect((await f.mailbox.deliver(sent.deliveries[0]!.id)).state).toBe('leased')
      expect((await f.mailbox.retryDelivery(sent.deliveries[0]!.id)).state).toBe('leased')
      release()
      expect((await first).state).toBe('delivered')
      expect((await f.mailbox.listDeliveries())[0]?.revision).toBe(3)
    } finally { release(); await cleanup(f.workspacePath) }
  })
  it('broadcasts to active peers but not the authenticated sender', async () => {
    const f = await mailboxOf({ recipients: [{ memberId: 'm-1', sessionId: 's-1', bindingGeneration: 1 }, { memberId: 'm-2', sessionId: 's-2', bindingGeneration: 1 }, { memberId: 'm-3', active: false }] })
    try {
      const result = await f.mailbox.sendFromSession('s-1', message({ to: 'team' }))
      expect(result.deliveries.map(row => row.recipient)).toEqual(['m-2'])
      expect(f.calls.map(call => call.sessionId)).toEqual(['s-2'])
      const self = await f.mailbox.sendFromSession('s-1', message())
      expect(self.deliveries[0]?.recipient).toBe('m-1')
    } finally { await cleanup(f.workspacePath) }
  })
  it('does not create an orphan or self echo when a sender is the only active member', async () => {
    const f = await mailboxOf()
    try {
      await expect(f.mailbox.sendFromSession('s-1', message({ to: 'team' }))).rejects.toThrow('no other active recipients')
      expect(await f.mailbox.listMessages()).toHaveLength(0)
      expect(f.calls).toHaveLength(0)
    } finally { await cleanup(f.workspacePath) }
  })
  it('returns an active lease as delivery in progress without admitting a second command', async () => {
    const f = await mailboxOf({ autoDeliver: false })
    try {
      const sent = await f.mailbox.sendFromHuman(message())
      await f.mailbox.claimDelivery(sent.deliveries[0]!.id)
      await expect(f.mailbox.deliver(sent.deliveries[0]!.id)).resolves.toMatchObject({ state: 'leased' })
      expect(f.calls).toHaveLength(0)
    } finally { await cleanup(f.workspacePath) }
  })
})

describe('message text is not compressed by delivery', () => {
  it('preserves Russian prose, code identifiers, spaces and multiline Markdown', async () => {
    const content = 'Раунд 2: PASS с замечаниями.\n\n- Проверка `make check` завершилась: exit 0.\n- Неблокирующее замечание — поле `created_by`.\n\nПолный разбор — в вердикте; слова  с  двумя пробелами сохранены.'
    let queued: readonly unknown[] = []
    let admitted: TestCommand | undefined
    const value = await mailboxOf({
      admit: async (request) => { queued = request.content; admitted = command('unicode-message', request); return { record: admitted, duplicate: false } },
      dispatch: async () => { if (admitted === undefined) throw new Error('not admitted'); return admitted },
    })
    try {
      const sent = await value.mailbox.sendFromSession('s-1', message({ content }))
      expect((await value.mailbox.getMessage(sent.message.id))?.content).toBe(content)
      expect(queued).toEqual([{ type: 'text', text: `Peer message from Builder (message): ${content}` }])
      const reopened = JSON.parse(await readFile(join(value.workspacePath, '.dsh-live-teams', 'teams', 'team-1', 'messages.json'), 'utf8')) as { messages: Array<{ content: string }> }
      expect(reopened.messages[0]?.content).toBe(content)
    } finally { await rm(value.workspacePath, { recursive: true, force: true }) }
  })
})

describe('B16.1 delivery outcomes', () => {
  const cases: Array<[MessageDeliveryState, MessageWakePolicy, string]> = [
    ['failed', 'never', 'failed'],
    ['failed', 'queue', 'failed'],
    ['delivered', 'never', 'delivered'],
    ['acknowledged', 'steer', 'delivered'],
    ['stored', 'never', 'inbox'],
    ['stored', 'queue', 'pending'],
  ]

  it.each(cases)('maps %s with %s wake policy to %s', (state, wakePolicy, expected) => {
    expect(messageDeliveryOutcome({ state, wakePolicy })).toBe(expected)
  })

  it('keeps the four outcome counters additive for a mixed delivery set', () => {
    const deliveries = [
      { state: 'delivered' as const, wakePolicy: 'queue' as const },
      { state: 'stored' as const, wakePolicy: 'never' as const },
      { state: 'stored' as const, wakePolicy: 'queue' as const },
      { state: 'failed' as const, wakePolicy: 'steer' as const },
    ]
    const counts = deliveries.reduce((result, delivery) => {
      const outcome = messageDeliveryOutcome(delivery)
      result[outcome] += 1
      return result
    }, { delivered: 0, inbox: 0, pending: 0, failed: 0 })
    expect(counts).toEqual({ delivered: 1, inbox: 1, pending: 1, failed: 1 })
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(deliveries.length)
  })

  it('reports a comment to an unbound member as inbox context, not failure', async () => {
    const { mailbox } = await mailboxOf({ recipients: [{ memberId: 'm-1', displayName: 'Builder', active: true }] })
    const result = await mailbox.sendFromHuman(message({ kind: 'comment' }))
    expect(result.deliveries[0]).toMatchObject({ state: 'stored', wakePolicy: 'never' })
    expect(messageDeliveryOutcome(result.deliveries[0]!)).toBe('inbox')
  })

})

async function cleanup(workspace: string): Promise<void> {
  const target = await realpath(workspace)
  if (!target.startsWith(join(await realpath(tmpdir()), 'live-teams-mailbox-'))) throw new Error('unexpected mailbox fixture cleanup target')
  await rm(target, { recursive: true, force: true })
}

describe('scheduler outbox idempotency', () => {
  it('rechecks delivery authority when a stored notification is retried in the background', async () => {
    const f = await mailboxOf({ autoDeliver: false })
    try {
      const sent = await f.mailbox.sendFromSchedulerOnce({ to: 'm-1', kind: 'message', content: 'Correction', threadId: 'guarded' })
      const reopened = createMailbox({ workspacePath: f.workspacePath, teamId: 'team-1', queue: f.queue, listRecipients: async () => [{ memberId: 'm-1', sessionId: 's-1', bindingGeneration: 1 }], canDeliver: async () => false })
      expect((await reopened.deliver(sent.deliveries[0]!.id)).state).toBe('failed')
      expect(f.calls).toHaveLength(0)
    } finally { await cleanup(f.workspacePath) }
  })
  it('atomically deduplicates a scheduler thread and reuses it after reopening the mailbox', async () => {
    const f = await mailboxOf()
    try {
      const draft: MessageDraft = { to: 'm-1', kind: 'message', content: 'One correction request', threadId: 'review-return-test' }
      const results = await Promise.all(Array.from({ length: 8 }, () => f.mailbox.sendFromSchedulerOnce(draft)))
      expect(new Set(results.map(result => result.message.id)).size).toBe(1)
      expect(await f.mailbox.listMessages()).toHaveLength(1)
      expect(f.calls).toHaveLength(1)
      const reopened = createMailbox({ workspacePath: f.workspacePath, teamId: 'team-1', queue: f.queue, listRecipients: async () => [{ memberId: 'm-1', sessionId: 's-1', bindingGeneration: 1, active: true }] })
      expect((await reopened.sendFromSchedulerOnce(draft)).message.id).toBe(results[0]!.message.id)
      expect(f.calls).toHaveLength(1)
    } finally { await cleanup(f.workspacePath) }
  })
  it('refuses reuse of a scheduler identity for changed content', async () => {
    const f = await mailboxOf({ autoDeliver: false })
    try {
      await f.mailbox.sendFromSchedulerOnce({ to: 'm-1', kind: 'message', content: 'First', threadId: 'same-key' })
      await expect(f.mailbox.sendFromSchedulerOnce({ to: 'm-1', kind: 'message', content: 'Changed', threadId: 'same-key' })).rejects.toThrow()
      expect(await f.mailbox.listMessages()).toHaveLength(1)
    } finally { await cleanup(f.workspacePath) }
  })
})

describe('B12 durable mailbox', () => {
  it('persists the message and every delivery row before live delivery', async () => {
    let observed: { messages: unknown; deliveries: unknown } | undefined
    const { workspacePath, mailbox } = await mailboxOf({
      audit: async () => {},
      admit: async (request) => {
        observed = {
          messages: JSON.parse(await readFile(join(workspacePath, '.dsh-live-teams', 'teams', 'team-1', 'messages.json'), 'utf8')) as unknown,
          deliveries: JSON.parse(await readFile(join(workspacePath, '.dsh-live-teams', 'teams', 'team-1', 'deliveries.json'), 'utf8')) as unknown,
        }
        const admitted = command('persisted-command', request)
        return { record: admitted, duplicate: false }
      },
      dispatch: async () => command('persisted-command', { idempotencyKey: 'persisted', sessionId: 's-1', bindingGeneration: 1, mode: 'queue' }),
    })
    const result = await mailbox.sendFromHuman(message())
    expect(observed).toMatchObject({ messages: { messages: [expect.objectContaining({ id: result.message.id, content: 'hello' })] }, deliveries: { deliveries: [expect.objectContaining({ messageId: result.message.id, state: 'leased' })] } })
    expect((await mailbox.listMessages())).toHaveLength(1)
    expect((await mailbox.listDeliveries())[0]?.state).toBe('delivered')
  })

  it('attributes peer and human deliveries before queue admission', async () => {
    const admitted: string[] = []
    const { mailbox } = await mailboxOf({ admit: async (request) => { admitted.push(String((request.content[0] as { text?: unknown }).text)); return { record: command(`attributed-${admitted.length}`, request), duplicate: false } } })
    await mailbox.sendFromSession('s-1', message({ content: 'peer body' }))
    await mailbox.sendFromHuman(message({ content: 'human body' }))
    expect(admitted[0]).toBe('Peer message from Builder (message): peer body')
    expect(admitted[1]).toBe('Human instruction (message): human body')
  })

  it('atomically expands a team broadcast to one row per active member', async () => {
    const { mailbox } = await mailboxOf({ recipients: [
      { memberId: 'm-1', sessionId: 's-1', bindingGeneration: 1, active: true },
      { memberId: 'm-2', sessionId: 's-2', bindingGeneration: 2, active: true },
      { memberId: 'm-3', sessionId: 's-3', bindingGeneration: 1, active: false },
    ], autoDeliver: false })
    const result = await mailbox.sendFromHuman(message({ to: 'team' }))
    expect(result.message.to).toBe('team')
    expect(result.deliveries.map((delivery) => delivery.recipient)).toEqual(['m-1', 'm-2'])
    expect((await mailbox.listMessages())).toHaveLength(1)
    expect((await mailbox.listDeliveries())).toHaveLength(2)
    expect((await mailbox.listDeliveries()).every((delivery) => delivery.messageId === result.message.id && delivery.state === 'stored')).toBe(true)
  })

  it('derives from the session binding and rejects a forged sender argument', async () => {
    const { mailbox } = await mailboxOf({ autoDeliver: false })
    const result = await mailbox.sendFromSession('s-1', message())
    expect(result.message.from).toBe('m-1')
    await expect(mailbox.sendFromSession('s-1', { ...message(), from: 'm-2' } as MessageDraft & { from: string })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    await expect(mailbox.sendFromSession('s-2', message())).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })

  it('time-limited lease blocks a second claim and permits takeover after expiry', async () => {
    let now = 100
    const { mailbox } = await mailboxOf({ now: () => now, leaseMs: 10, autoDeliver: false })
    const { deliveries } = await mailbox.sendFromHuman(message())
    const first = await mailbox.claimDelivery(deliveries[0]!.id)
    expect(first?.state).toBe('leased')
    expect(await mailbox.claimDelivery(deliveries[0]!.id)).toBeUndefined()
    now = 111
    const reclaimed = await mailbox.claimDelivery(deliveries[0]!.id)
    expect(reclaimed?.state).toBe('leased')
    expect(reclaimed?.revision).toBeGreaterThan(first?.revision ?? 0)
  })

  it('successful bridge admission is terminal and a repeated delivery creates no second model turn', async () => {
    const { mailbox, calls } = await mailboxOf()
    const { deliveries } = await mailbox.sendFromHuman(message())
    expect(deliveries[0]?.state).toBe('delivered')
    const repeated = await mailbox.deliver(deliveries[0]!.id)
    expect(repeated.state).toBe('delivered')
    expect(calls).toHaveLength(1)
    // The pair identifies the delivery; the mode is part of the attempt, because
    // an idempotency key is bound to the first command admitted under it.
    expect(calls[0]?.idempotencyKey).toBe(`${deliveries[0]?.messageId}:m-1:queue`)
  })

  it('never wake policy stores without admitting anything', async () => {
    const { mailbox, calls } = await mailboxOf()
    const { deliveries } = await mailbox.sendFromHuman(message({ kind: 'comment' }))
    expect(deliveries[0]).toMatchObject({ wakePolicy: 'never', ackPolicy: 'consumption', state: 'stored' })
    expect(calls).toHaveLength(0)
  })

  it('human delivery is stored and never wakes an agent', async () => {
    const { mailbox, calls } = await mailboxOf()
    const { deliveries } = await mailbox.sendFromSession('s-1', message({ to: 'human' }))
    expect(deliveries[0]).toMatchObject({ recipient: 'human', wakePolicy: 'never', ackPolicy: 'consumption', state: 'stored' })
    expect(calls).toHaveLength(0)
    const acknowledged = await mailbox.acknowledge(deliveries[0]!.messageId, 'human')
    expect(acknowledged.delivery.state).toBe('acknowledged')
  })

  it('deduplicates a formal acknowledgement by message and recipient', async () => {
    const { mailbox } = await mailboxOf({ autoDeliver: false })
    const { message: sent } = await mailbox.sendFromHuman(message({ kind: 'comment' }))
    const first = await mailbox.acknowledge(sent.id, 'm-1', true)
    const second = await mailbox.acknowledge(sent.id, 'm-1', true)
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.delivery.state).toBe('acknowledged')
    expect((await mailbox.listDeliveries())).toHaveLength(1)
  })

  it('records a visible failure with a reason and does not use another transport', async () => {
    const calls: string[] = []
    const { mailbox } = await mailboxOf({ dispatch: async () => { calls.push('dispatch'); throw new LiveTeamsError('DELIVERY_REJECTED', 'bridge refused') } })
    const { deliveries } = await mailbox.sendFromHuman(message())
    expect(deliveries[0]).toMatchObject({ state: 'failed', failure: 'bridge refused' })
    expect(calls).toEqual(['dispatch'])
    expect((await mailbox.listDeliveries())[0]?.state).toBe('failed')
  })

  it('selects queue for messages and steer for directions', async () => {
    const seen: string[] = []
    const { mailbox } = await mailboxOf({
      autoDeliver: false,
      admit: async (request) => { seen.push(request.mode); return { record: command(`c-${seen.length}`, request), duplicate: false } },
      // Succeed at dispatch so the assertion measures mode selection alone.
      dispatch: async (commandId) => command(commandId, { sessionId: 's-1', bindingGeneration: 1, idempotencyKey: 'k', mode: 'queue' }),
    })
    await mailbox.sendFromHuman(message({ kind: 'message' }))
    await mailbox.sendFromHuman(message({ kind: 'direction' }))
    const deliveries = await mailbox.listDeliveries()
    await mailbox.deliver(deliveries[0]!.id)
    await mailbox.deliver(deliveries[1]!.id)
    expect(seen).toEqual(['queue', 'steer'])
  })

  it('rejects a torn publication and duplicate rows instead of reading them', async () => {
    const { workspacePath, mailbox } = await mailboxOf({ autoDeliver: false })
    await mailbox.sendFromHuman({ to: 'human', kind: 'comment', content: 'first' })
    const teams = join(workspacePath, '.dsh-live-teams', 'teams', 'team-1')
    // A lone file is a torn pair: reading it as "no messages" would lose a send.
    await rm(join(teams, 'deliveries.json'))
    await expect(mailbox.listMessages()).rejects.toMatchObject({ code: 'STATE_CORRUPT' })

    const { workspacePath: cleanPath, mailbox: clean } = await mailboxOf({ autoDeliver: false })
    await clean.sendFromHuman({ to: 'human', kind: 'comment', content: 'first' })
    const cleanTeams = join(cleanPath, '.dsh-live-teams', 'teams', 'team-1')
    const messages = JSON.parse(await readFile(join(cleanTeams, 'messages.json'), 'utf8')) as { messages: unknown[] }
    messages.messages.push(messages.messages[0])
    await writeFile(join(cleanTeams, 'messages.json'), JSON.stringify(messages))
    await expect(clean.listMessages()).rejects.toMatchObject({ code: 'STATE_CORRUPT' })
  })

  it('falls back to the queue when a direction cannot be steered', async () => {
    const modes: string[] = []
    const audits: MailboxAuditEvent[] = []
    const { mailbox } = await mailboxOf({
      audit: async (event) => { audits.push(event) },
      admit: async (request) => {
        modes.push(request.mode)
        if (request.mode === 'steer') throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'cannot steer an idle session')
        return { record: command(`command-${String(modes.length)}`, request), duplicate: false }
      },
      dispatch: async (commandId) => command(commandId, { sessionId: 's-1', bindingGeneration: 1, idempotencyKey: 'k', mode: 'queue' }),
    })
    const sent = await mailbox.sendFromHuman({ to: 'm-1', kind: 'direction', content: 'steer please' })
    const delivered = await mailbox.deliver(sent.deliveries[0]?.id as string)
    expect(modes).toEqual(['steer', 'queue'])
    expect(delivered.state).toBe('delivered')
    expect(audits.some((event) => event.kind === 'delivery/steer-fallback')).toBe(true)
  })

  it('writes one audit event for each mailbox transition', async () => {
    const events: MailboxAuditEvent[] = []
    const { mailbox } = await mailboxOf({ audit: async (event) => { events.push(event) } })
    const { message: sent, deliveries } = await mailbox.sendFromHuman(message())
    await mailbox.acknowledge(sent.id, 'm-1')
    expect(events.map((event) => event.kind)).toEqual(['message/sent', 'delivery/leased', 'delivery/delivered'])
    expect(deliveries[0]?.state).toBe('delivered')
  })

  it('rejects malformed persisted state instead of accepting unreadable rows', async () => {
    const { workspacePath, mailbox } = await mailboxOf({ autoDeliver: false })
    await mailbox.sendFromHuman(message())
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(workspacePath, '.dsh-live-teams', 'teams', 'team-1', 'deliveries.json'), JSON.stringify({ schemaVersion: 1, teamId: 'team-1', deliveries: [{ id: 'd', messageId: 'missing', recipient: 'm-1', wakePolicy: 'queue', ackPolicy: 'delivery', state: 'stored', revision: 1 }] })))
    await expect(mailbox.listDeliveries()).rejects.toMatchObject({ code: 'STATE_CORRUPT' })
  })

  it('resolves ids, trimmed case-insensitive names, team, and human before persistence', async () => {
    const { mailbox } = await mailboxOf({
      autoDeliver: false,
      recipients: [
        { memberId: 'm-1', displayName: 'Builder', sessionId: 's-1', bindingGeneration: 1, active: true },
        { memberId: 'm-2', displayName: 'Reviewer', sessionId: 's-2', bindingGeneration: 1, active: true },
      ],
    })
    const byName = await mailbox.sendFromHuman(message({ to: '  bUiLdEr  ' }))
    const byId = await mailbox.sendFromHuman(message({ to: 'm-2' }))
    const team = await mailbox.sendFromHuman(message({ to: 'team' }))
    const human = await mailbox.sendFromHuman(message({ to: 'human' }))
    expect(byName.message.to).toBe('m-1')
    expect(byName.deliveries.map((delivery) => delivery.recipient)).toEqual(['m-1'])
    expect(byId.deliveries.map((delivery) => delivery.recipient)).toEqual(['m-2'])
    expect(team.deliveries.map((delivery) => delivery.recipient)).toEqual(['m-1', 'm-2'])
    expect(human.deliveries.map((delivery) => delivery.recipient)).toEqual(['human'])
  })

  it('refuses ambiguous and unknown recipients without writing messages or deliveries', async () => {
    const ambiguous = await mailboxOf({
      autoDeliver: false,
      recipients: [
        { memberId: 'm-1', displayName: 'Builder', active: true },
        { memberId: 'm-2', displayName: 'builder', active: true },
      ],
    })
    await expect(ambiguous.mailbox.sendFromHuman(message({ to: 'BUILDER' }))).rejects.toThrow(/ambiguous.*m-1.*m-2/u)
    expect(await ambiguous.mailbox.listMessages()).toEqual([])
    expect(await ambiguous.mailbox.listDeliveries()).toEqual([])
    const unknown = await mailboxOf({ autoDeliver: false })
    await expect(unknown.mailbox.sendFromHuman(message({ to: 'Stranger' }))).rejects.toThrow(/unknown recipient.*m-1/u)
    expect(await unknown.mailbox.listMessages()).toEqual([])
    expect(await unknown.mailbox.listDeliveries()).toEqual([])
  })

  it('keeps paused or unbound members addressable and reports a durable failed delivery', async () => {
    const { mailbox } = await mailboxOf({ recipients: [
      { memberId: 'm-paused', displayName: 'Paused', active: true },
    ] })
    const result = await mailbox.sendFromHuman(message({ to: ' paused ' }))
    expect(result.message.to).toBe('m-paused')
    expect(result.deliveries[0]).toMatchObject({ recipient: 'm-paused', state: 'failed', failure: 'recipient has no current session binding' })
    expect(await mailbox.listMessages()).toHaveLength(1)
    expect(await mailbox.listDeliveries()).toHaveLength(1)
  })

  it('does not make inactive members unreachable for direct addressing', async () => {
    const { mailbox } = await mailboxOf({ recipients: [
      { memberId: 'm-paused', displayName: 'Paused', active: false },
    ] })
    const result = await mailbox.sendFromHuman(message({ to: 'm-paused' }))
    expect(result.message.to).toBe('m-paused')
    expect(result.deliveries[0]?.recipient).toBe('m-paused')
  })
})
