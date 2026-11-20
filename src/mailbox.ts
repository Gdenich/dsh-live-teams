import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, clone, fileExists, readJson, withProcessLock } from './storage.js'
import { ERROR_CODES, LiveTeamsError } from './errors.js'

export type MessageKind = 'message' | 'direction' | 'comment'
export type MessageWakePolicy = 'never' | 'queue' | 'steer'
export type MessageAckPolicy = 'delivery' | 'consumption' | 'formal'
export type MessageDeliveryState = 'stored' | 'leased' | 'delivered' | 'acknowledged' | 'failed'
export type MessageDeliveryOutcome = 'delivered' | 'inbox' | 'pending' | 'failed'

/**
 * The one delivery failure the dispatcher may retry on its own: the recipient had
 * no usable binding yet. Every other failure is terminal and stays visible —
 * the reconciler never resurrects a delivery for a reason it cannot name.
 */
export const NO_SESSION_FAILURE = 'recipient has no current session binding'

/** The immutable, frozen B12 message envelope. */
export interface TeamMessage {
  id: string
  teamId: string
  from: string | 'human' | 'scheduler'
  to: string | 'human' | 'team'
  kind: MessageKind
  content: string
  threadId?: string
  createdAt: number
}

/** Recipient-specific mutable delivery state. */
export interface MessageDelivery {
  id: string
  messageId: string
  recipient: string | 'human'
  wakePolicy: MessageWakePolicy
  ackPolicy: MessageAckPolicy
  state: MessageDeliveryState
  claimedAt?: number
  deliveredAt?: number
  acknowledgedAt?: number
  failure?: string
  revision: number
}

export type MessageDraft = {
  to: string | 'human' | 'team'
  kind: MessageKind
  content: string
  threadId?: string
}

/** Identity is an operation context, not a field supplied in MessageDraft. */
export type MailboxActor =
  | { type: 'session'; sessionId: string }
  | { type: 'human' }
  | { type: 'scheduler' }

export type MailboxRecipient = {
  memberId: string
  displayName?: string
  sessionId?: string
  bindingGeneration?: number
  active?: boolean
}

export type ResolvedMailboxRecipient = {
  readonly recipient: TeamMessage['to']
  readonly name: string
}

function recipientLabel(recipient: MailboxRecipient): string {
  return recipient.displayName?.trim() || recipient.memberId
}

/** Resolve the one addressing vocabulary shared by member and human sends. */
export function resolveMailboxRecipient(value: string, recipients: readonly MailboxRecipient[]): ResolvedMailboxRecipient {
  const requested = value.trim()
  const exact = recipients.find((candidate) => candidate.memberId === requested)
  if (exact !== undefined) return { recipient: exact.memberId, name: recipientLabel(exact) }
  if (requested === 'team') return { recipient: 'team', name: 'team' }
  if (requested === 'human') return { recipient: 'human', name: 'human' }
  const matching = recipients.filter((candidate) => candidate.displayName?.trim().toLocaleLowerCase() === requested.toLocaleLowerCase())
  if (matching.length === 1) {
    const candidate = matching[0]
    if (candidate === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'recipient resolution state disappeared')
    return { recipient: candidate.memberId, name: recipientLabel(candidate) }
  }
  if (matching.length > 1) {
    const candidates = matching.map((candidate) => `${candidate.memberId} (${recipientLabel(candidate)})`)
    throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `ambiguous recipient "${requested}"; candidates: ${candidates.join(', ')}`, { details: { candidates } })
  }
  const existing = recipients.map((candidate) => `${candidate.memberId} (${recipientLabel(candidate)})`)
  throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `unknown recipient "${requested}"; existing recipients: ${existing.length > 0 ? existing.join(', ') : 'none'}`, { details: { recipients: existing } })
}

export type MailboxAuditEvent = {
  kind: 'message/sent'
  teamId: string
  messageId: string
  from: TeamMessage['from']
  /** The sender, which is the actor of this transition. */
  actor: TeamMessage['from']
  to: TeamMessage['to']
  messageKind: MessageKind
  at: number
} | {
  kind: 'delivery/leased'
  teamId: string
  deliveryId: string
  messageId: string
  recipient: string
  at: number
  revision: number
} | {
  kind: 'delivery/delivered'
  teamId: string
  deliveryId: string
  messageId: string
  recipient: string
  at: number
  revision: number
} | {
  kind: 'delivery/acknowledged'
  teamId: string
  deliveryId: string
  messageId: string
  recipient: string
  /** The recipient acknowledges its own delivery, so it is the actor. */
  actor: string
  at: number
  revision: number
} | {
  kind: 'delivery/failed'
  teamId: string
  deliveryId: string
  messageId: string
  recipient: string
  reason: string
  at: number
  revision: number
} | {
  /** A direction could not be steered and was queued instead. */
  kind: 'delivery/steer-fallback'
  teamId: string
  deliveryId: string
  messageId: string
  reason: string
  at: number
}

export type CommandQueueRecord = {
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

type CommandRecordLike = {
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

export type CommandQueueLike = {
  admit(request: {
    idempotencyKey: string
    sessionId: string
    bindingGeneration: number
    mode: 'queue' | 'steer'
    content: readonly unknown[]
    reason?: string
    causationId?: string
  }): Promise<{ record: CommandRecordLike; duplicate: boolean }>
  dispatch(commandId: string): Promise<CommandRecordLike>
}

export type MailboxAuthorizeRequest = { from: TeamMessage['from']; to: string }
export type MailboxOptions = {
  workspacePath: string
  teamId: string
  queue: CommandQueueLike
  listRecipients: () => Promise<readonly MailboxRecipient[]>
  /** Optional policy gate, called before any mailbox row is persisted. */
  authorize?: (request: MailboxAuthorizeRequest) => void | Promise<void>
  resolveSessionSender?: (sessionId: string) => Promise<string | undefined> | string | undefined
  /** Durable guarded scheduler traffic must still be authorized on background retries. */
  canDeliver?: (message: TeamMessage, recipient: MailboxRecipient) => Promise<boolean>
  appendAudit?: (event: MailboxAuditEvent) => Promise<void>
  now?: () => number
  leaseMs?: number
  /** Defaults to true: send persists before attempting each live delivery. */
  autoDeliver?: boolean
}

type MailboxSnapshot = { messages: TeamMessage[]; deliveries: MessageDelivery[] }
export type SendResult = { message: TeamMessage; deliveries: MessageDelivery[] }
export type AcknowledgeResult = { delivery: MessageDelivery; duplicate: boolean }

type RecordValue = Record<string, unknown>
const SCHEMA_VERSION = 1
const DEFAULT_LEASE_MS = 30_000
const MESSAGE_KEYS = new Set(['id', 'teamId', 'from', 'to', 'kind', 'content', 'threadId', 'createdAt'])
const DELIVERY_KEYS = new Set(['id', 'messageId', 'recipient', 'wakePolicy', 'ackPolicy', 'state', 'claimedAt', 'deliveredAt', 'acknowledgedAt', 'failure', 'revision'])
const MESSAGE_WRAPPER_KEYS = new Set(['schemaVersion', 'teamId', 'messages'])
const DELIVERY_WRAPPER_KEYS = new Set(['schemaVersion', 'teamId', 'deliveries'])

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function nonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0 }
function keysAllowed(value: RecordValue, keys: Set<string>): boolean { return Object.keys(value).every((key) => keys.has(key)) }
function isMessageKind(value: unknown): value is MessageKind { return value === 'message' || value === 'direction' || value === 'comment' }
function isWakePolicy(value: unknown): value is MessageWakePolicy { return value === 'never' || value === 'queue' || value === 'steer' }
function isAckPolicy(value: unknown): value is MessageAckPolicy { return value === 'delivery' || value === 'consumption' || value === 'formal' }
function isDeliveryState(value: unknown): value is MessageDeliveryState { return value === 'stored' || value === 'leased' || value === 'delivered' || value === 'acknowledged' || value === 'failed' }
function cloneMessage(value: TeamMessage): TeamMessage { return clone(value) }
function cloneDelivery(value: MessageDelivery): MessageDelivery { return clone(value) }
function messagePolicy(kind: MessageKind, recipient: TeamMessage['to']): Pick<MessageDelivery, 'wakePolicy' | 'ackPolicy'> {
  if (recipient === 'human') return { wakePolicy: 'never', ackPolicy: 'consumption' }
  if (kind === 'comment') return { wakePolicy: 'never', ackPolicy: 'consumption' }
  if (kind === 'direction') return { wakePolicy: 'steer', ackPolicy: 'delivery' }
  return { wakePolicy: 'queue', ackPolicy: 'delivery' }
}

/** Derive the externally reported outcome from a final delivery state and policy. */
export function messageDeliveryOutcome(delivery: Pick<MessageDelivery, 'state' | 'wakePolicy'>): MessageDeliveryOutcome {
  if (delivery.state === 'failed') return 'failed'
  if (delivery.state === 'delivered' || delivery.state === 'acknowledged') return 'delivered'
  if (delivery.state === 'stored' && delivery.wakePolicy === 'never') return 'inbox'
  return 'pending'
}

function checkedMessage(value: unknown, teamId: string): TeamMessage {
  const candidate = record(value)
  if (candidate === undefined || !keysAllowed(candidate, MESSAGE_KEYS)
    || text(candidate.id) === undefined || candidate.teamId !== teamId
    || (candidate.from !== 'human' && candidate.from !== 'scheduler' && text(candidate.from) === undefined)
    || (candidate.to !== 'human' && candidate.to !== 'team' && text(candidate.to) === undefined)
    || !isMessageKind(candidate.kind) || typeof candidate.content !== 'string'
    || !nonNegativeInteger(candidate.createdAt)
    || (candidate.threadId !== undefined && text(candidate.threadId) === undefined)) {
    throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'invalid mailbox message state', { auditDetail: `invalid message in team ${teamId}` })
  }
  return clone(candidate as unknown as TeamMessage)
}

function checkedDelivery(value: unknown, teamId: string): MessageDelivery {
  const candidate = record(value)
  if (candidate === undefined || !keysAllowed(candidate, DELIVERY_KEYS)
    || text(candidate.id) === undefined || text(candidate.messageId) === undefined
    || (typeof candidate.recipient !== 'string' || candidate.recipient.length === 0)
    || !isWakePolicy(candidate.wakePolicy) || !isAckPolicy(candidate.ackPolicy) || !isDeliveryState(candidate.state)
    || !positiveInteger(candidate.revision)
    || (candidate.claimedAt !== undefined && !nonNegativeInteger(candidate.claimedAt))
    || (candidate.deliveredAt !== undefined && !nonNegativeInteger(candidate.deliveredAt))
    || (candidate.acknowledgedAt !== undefined && !nonNegativeInteger(candidate.acknowledgedAt))
    || (candidate.failure !== undefined && text(candidate.failure) === undefined)) {
    throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'invalid mailbox delivery state', { auditDetail: `invalid delivery in team ${teamId}` })
  }
  if (candidate.state === 'failed' && candidate.failure === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'failed delivery has no reason')
  if (candidate.state === 'acknowledged' && candidate.acknowledgedAt === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'acknowledged delivery has no timestamp')
  if (candidate.state === 'delivered' && candidate.deliveredAt === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'delivered delivery has no timestamp')
  if (candidate.state === 'stored' && (candidate.claimedAt !== undefined || candidate.deliveredAt !== undefined || candidate.acknowledgedAt !== undefined || candidate.failure !== undefined)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'stored delivery has transition fields')
  if (candidate.state === 'leased' && candidate.claimedAt === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'leased delivery has no claim timestamp')
  // Acknowledgement requires only its own timestamp. A delivery need not pass
  // through a lease or even through the mailbox to be acknowledged: a formal
  // assignment the recipient already holds is confirmed by the receiving tool,
  // and a human-inbox row is acknowledged by being read.
  return clone(candidate as unknown as MessageDelivery)
}

function checkedArray(value: unknown, key: 'messages' | 'deliveries', teamId: string): TeamMessage[] | MessageDelivery[] {
  const wrapper = record(value)
  const wrapperKeys = key === 'messages' ? MESSAGE_WRAPPER_KEYS : DELIVERY_WRAPPER_KEYS
  if (wrapper === undefined || !keysAllowed(wrapper, wrapperKeys) || wrapper.schemaVersion !== SCHEMA_VERSION || wrapper.teamId !== teamId || !Array.isArray(wrapper[key])) {
    throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, `invalid mailbox ${key} state`, { auditDetail: `invalid ${key}.json in team ${teamId}` })
  }
  return key === 'messages'
    ? (wrapper.messages as unknown[]).map((entry) => checkedMessage(entry, teamId))
    : (wrapper.deliveries as unknown[]).map((entry) => checkedDelivery(entry, teamId))
}

function requestDraft(value: unknown): MessageDraft {
  const candidate = record(value)
  if (candidate === undefined || Object.keys(candidate).some((key) => !new Set(['to', 'kind', 'content', 'threadId']).has(key))
    || typeof candidate.to !== 'string' || candidate.to.length === 0 || !isMessageKind(candidate.kind)
    || typeof candidate.content !== 'string'
    || (candidate.threadId !== undefined && text(candidate.threadId) === undefined)
    || candidate.from !== undefined) {
    throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'invalid mailbox message request')
  }
  return {
    to: candidate.to as MessageDraft['to'], kind: candidate.kind, content: candidate.content,
    ...(candidate.threadId === undefined ? {} : { threadId: candidate.threadId as string }),
  }
}

function senderActor(value: unknown): MailboxActor {
  const candidate = record(value)
  if (candidate?.type === 'human') return { type: 'human' }
  if (candidate?.type === 'scheduler') return { type: 'scheduler' }
  if (candidate?.type === 'session' && text(candidate.sessionId) !== undefined) return { type: 'session', sessionId: candidate.sessionId as string }
  throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'mailbox sender identity is required')
}

export class MailboxService {
  private readonly workspacePath: string
  private readonly teamId: string
  private readonly queue: CommandQueueLike
  private readonly listRecipients: MailboxOptions['listRecipients']
  private readonly authorize: MailboxOptions['authorize']
  private readonly resolveSessionSender: MailboxOptions['resolveSessionSender']
  private readonly canDeliver: MailboxOptions['canDeliver']
  private readonly appendAudit: MailboxOptions['appendAudit']
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly autoDeliver: boolean
  private readonly directory: string
  private readonly messagesFile: string
  private readonly deliveriesFile: string
  private readonly lockFile: string

  constructor(options: MailboxOptions) {
    if (text(options?.workspacePath) === undefined || text(options?.teamId) === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'mailbox requires workspacePath and teamId')
    if (!options.queue || typeof options.queue.admit !== 'function' || typeof options.queue.dispatch !== 'function') throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'mailbox requires the existing command queue')
    if (typeof options.listRecipients !== 'function') throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'mailbox requires a recipient resolver')
    this.workspacePath = path.resolve(options.workspacePath)
    this.teamId = options.teamId
    this.queue = options.queue
    this.listRecipients = options.listRecipients
    this.canDeliver = options.canDeliver
    this.authorize = options.authorize
    this.resolveSessionSender = options.resolveSessionSender
    this.appendAudit = options.appendAudit
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    if (!positiveInteger(this.leaseMs)) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'mailbox leaseMs must be positive')
    this.autoDeliver = options.autoDeliver ?? true
    this.directory = path.join(this.workspacePath, '.dsh-live-teams', 'teams', this.teamId)
    this.messagesFile = path.join(this.directory, 'messages.json')
    this.deliveriesFile = path.join(this.directory, 'deliveries.json')
    this.lockFile = path.join(this.directory, '.mailbox.lock')
  }

  async listMessages(): Promise<TeamMessage[]> { return (await this.snapshot()).messages.map(cloneMessage) }
  async listDeliveries(): Promise<MessageDelivery[]> { return (await this.snapshot()).deliveries.map(cloneDelivery) }
  async getMessage(messageId: string): Promise<TeamMessage | undefined> { return (await this.listMessages()).find((message) => message.id === messageId) }
  async getDelivery(deliveryId: string): Promise<MessageDelivery | undefined> { return (await this.listDeliveries()).find((delivery) => delivery.id === deliveryId) }
  async deliveriesFor(messageId: string): Promise<MessageDelivery[]> { return (await this.listDeliveries()).filter((delivery) => delivery.messageId === messageId) }

  /**
   * Internal send path.
   *
   * Deliberately private: an actor argument that any caller may supply would let
   * a member send as `human` or as another member, which ADR 0004 forbids. The
   * public entries derive the sender instead — from the calling Session binding
   * for member traffic, and from the host itself for human and scheduler paths.
   */
  private async send(draftValue: unknown, actorValue: unknown, once = false): Promise<SendResult> {
    const draft = requestDraft(draftValue)
    const actor = senderActor(actorValue)
    const from = await this.resolveFrom(actor)
    const result = await withProcessLock(this.lockFile, async () => {
      const snapshot = await this.readSnapshot()
      // Resolve every direct recipient inside the persistence lock and before
      // constructing either row. This is the only send path, so no caller can
      // create a delivery for a non-member by skipping a pre-check.
      const availableRecipients = await this.listRecipients()
      const resolved = resolveMailboxRecipient(draft.to, availableRecipients)
      const recipients = resolved.recipient === 'team' ? availableRecipients.filter((recipient) => recipient.active !== false && (actor.type !== 'session' || recipient.memberId !== from)) : []
      if (this.authorize !== undefined) await this.authorize({ from, to: resolved.recipient })
      if (resolved.recipient === 'team' && recipients.length === 0) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'team broadcast has no other active recipients')
      if (once) {
        const existing = snapshot.messages.find(message => message.from === 'scheduler' && message.threadId === draft.threadId)
        if (existing !== undefined) {
          if (existing.to !== resolved.recipient || existing.kind !== draft.kind || existing.content !== draft.content) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'scheduler notification identity reused with different content')
          return { message: cloneMessage(existing), deliveries: snapshot.deliveries.filter(delivery => delivery.messageId === existing.id).map(cloneDelivery) }
        }
      }
      const message: TeamMessage = {
        id: randomUUID(), teamId: this.teamId, from, to: resolved.recipient, kind: draft.kind, content: draft.content,
        ...(draft.threadId === undefined ? {} : { threadId: draft.threadId }), createdAt: this.now(),
      }
      const recipientIds = resolved.recipient === 'team' ? recipients.map((recipient) => recipient.memberId) : [resolved.recipient]
      if (recipientIds.some((recipient) => typeof recipient !== 'string' || recipient.length === 0)) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'mailbox recipient is invalid')
      const deliveries = recipientIds.map((recipient): MessageDelivery => {
        const policy = messagePolicy(draft.kind, recipient as TeamMessage['to'])
        return { id: randomUUID(), messageId: message.id, recipient: recipient as string | 'human', ...policy, state: 'stored', revision: 1 }
      })
      await this.persist({ messages: [...snapshot.messages, message], deliveries: [...snapshot.deliveries, ...deliveries] })
      await this.audit({ kind: 'message/sent', teamId: this.teamId, messageId: message.id, from: message.from, actor: message.from, to: message.to, messageKind: message.kind, at: this.now() })
      return { message: cloneMessage(message), deliveries: deliveries.map(cloneDelivery) }
    })
    if (!this.autoDeliver) return result
    const delivered: MessageDelivery[] = []
    for (const delivery of result.deliveries) {
      if (once && (delivery.state === 'failed' || delivery.state === 'leased' && delivery.claimedAt !== undefined && delivery.claimedAt + this.leaseMs > this.now())) delivered.push(delivery)
      else delivered.push(await this.deliver(delivery.id))
    }
    return { message: result.message, deliveries: delivered }
  }

  async sendFromSession(sessionId: string, draft: MessageDraft): Promise<SendResult> { return this.send(draft, { type: 'session', sessionId }) }
  async sendFromHuman(draft: MessageDraft): Promise<SendResult> { return this.send(draft, { type: 'human' }) }
  async sendFromScheduler(draft: MessageDraft): Promise<SendResult> { return this.send(draft, { type: 'scheduler' }) }
  /** Internal outbox identity uses the existing immutable thread field; no mailbox schema change. */
  async sendFromSchedulerOnce(draft: MessageDraft): Promise<SendResult> {
    if (text(draft.threadId) === undefined) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'scheduler-once requires a stable thread identity')
    return withProcessLock(`${this.lockFile}:scheduler-once:${draft.threadId}`, () => this.send(draft, { type: 'scheduler' }, true))
  }

  async claimDelivery(deliveryId: string): Promise<MessageDelivery | undefined> {
    let leased: MessageDelivery | undefined
    await withProcessLock(this.lockFile, async () => {
      const snapshot = await this.readSnapshot()
      const index = snapshot.deliveries.findIndex((delivery) => delivery.id === deliveryId)
      if (index < 0) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, `unknown mailbox delivery "${deliveryId}"`)
      const current = snapshot.deliveries[index]
      if (current === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox delivery disappeared')
      if (current.state === 'delivered' || current.state === 'acknowledged') { leased = cloneDelivery(current); return }
      if (current.state === 'leased' && current.claimedAt !== undefined && current.claimedAt + this.leaseMs > this.now()) return
      if (current.state === 'failed') return
      const next: MessageDelivery = { ...current, state: 'leased', claimedAt: this.now(), revision: current.revision + 1 }
      delete next.failure
      delete next.deliveredAt
      delete next.acknowledgedAt
      snapshot.deliveries[index] = next
      await this.persist(snapshot)
      await this.audit({ kind: 'delivery/leased', teamId: this.teamId, deliveryId: next.id, messageId: next.messageId, recipient: next.recipient, at: this.now(), revision: next.revision })
      leased = cloneDelivery(next)
    })
    return leased
  }

  async deliver(deliveryId: string): Promise<MessageDelivery> {
    const existing = await this.getDelivery(deliveryId)
    if (existing === undefined) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, `unknown mailbox delivery "${deliveryId}"`)
    if (existing.state === 'delivered' || existing.state === 'acknowledged') return existing
    // Non-waking and human deliveries are durable inbox/context rows. They do
    // not need a lease and must never reach the command queue.
    if (existing.recipient === 'human' || existing.wakePolicy === 'never') return existing
    const claimed = await this.claimDelivery(deliveryId)
    if (claimed === undefined) {
      const current = await this.getDelivery(deliveryId)
      if (current === undefined) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, `unknown mailbox delivery "${deliveryId}"`)
      if (current.state === 'leased') return current // Another owner is delivering; this is pending, not refusal.
      if (current.state === 'failed') throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, current.failure ?? 'mailbox delivery failed')
      return current
    }
    if (claimed.state === 'delivered' || claimed.state === 'acknowledged') return claimed
    const message = await this.getMessage(claimed.messageId)
    if (message === undefined) return this.fail(claimed.id, 'mailbox message is missing')
    if (claimed.recipient === 'human' || claimed.wakePolicy === 'never') return claimed
    const recipient = (await this.listRecipients()).find((entry) => entry.memberId === claimed.recipient && entry.active !== false)
    if (recipient === undefined || recipient.sessionId === undefined || recipient.bindingGeneration === undefined) return this.fail(claimed.id, NO_SESSION_FAILURE)
    try {
      if (this.canDeliver !== undefined && !await this.canDeliver(message, recipient)) return this.fail(claimed.id, 'automatic review return capability is no longer current')
      // A direction asks to steer at a safe boundary, but steering is only
      // possible into an active turn. When the transport refuses it — at
      // admission or at dispatch — the same message is queued instead of being
      // lost, and the fallback is audited.
      const senderName = message.from === 'human' || message.from === 'scheduler' ? undefined : (await this.listRecipients()).find((entry) => entry.memberId === message.from)?.displayName
       const first = await this.attemptDelivery(message, claimed, recipient, claimed.wakePolicy, senderName)
      if (first.kind === 'delivered') return this.markDelivered(claimed.id)
      if (claimed.wakePolicy !== 'steer') return this.fail(claimed.id, first.reason)
      await this.audit({ kind: 'delivery/steer-fallback', teamId: this.teamId, deliveryId: claimed.id, messageId: message.id, reason: first.reason, at: this.now() })
      const second = await this.attemptDelivery(message, claimed, recipient, 'queue', senderName)
      if (second.kind === 'delivered') return this.markDelivered(claimed.id)
      return this.fail(claimed.id, second.reason)
    } catch (error) {
      return this.fail(claimed.id, error instanceof LiveTeamsError ? (error.auditDetail ?? error.message) : error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * One transport attempt in one mode.
   *
   * The idempotency key carries the mode, because the key is bound to the first
   * command admitted under it: reusing one key for a queue retry after a steer
   * attempt would return the steer command and change nothing. The mode is part
   * of what makes this attempt distinct, and `(messageId, recipient)` still
   * identifies the delivery itself.
   */
  private async attemptDelivery(
    message: TeamMessage,
    claimed: MessageDelivery,
    recipient: { sessionId?: string; bindingGeneration?: number; displayName?: string },
    mode: 'queue' | 'steer',
    senderName?: string,
  ): Promise<{ kind: 'delivered' } | { kind: 'refused'; reason: string }> {
    try {
      const admission = await this.admitOnce(message, claimed, recipient, mode, senderName)
      const command = await this.queue.dispatch(admission.record.commandId)
      if (command.state === 'admitted' || command.state === 'applied') return { kind: 'delivered' }
      return { kind: 'refused', reason: command.failureDetail ?? command.failureCode ?? 'command queue did not admit delivery' }
    } catch (error) {
      // A refusal at admission is as much a refusal as one at dispatch: both
      // mean this mode did not carry the message.
      return { kind: 'refused', reason: error instanceof LiveTeamsError ? (error.auditDetail ?? error.message) : error instanceof Error ? error.message : String(error) }
    }
  }

  private async admitOnce(message: TeamMessage, claimed: MessageDelivery, recipient: { sessionId?: string; bindingGeneration?: number }, mode: 'queue' | 'steer', senderName?: string) {
    // Scheduler traffic is neither human instruction nor peer collaboration:
    // ADR 0004 puts it below peer messages, so it must not arrive labelled as one.
    const attributed = message.from === 'human'
      ? `Human instruction (${message.kind}): ${message.content}`
      : message.from === 'scheduler'
        ? `Scheduler notification (${message.kind}): ${message.content}`
        : `Peer message from ${senderName ?? message.from} (${message.kind}): ${message.content}`
    return this.queue.admit({
      idempotencyKey: `${message.id}:${claimed.recipient}:${mode}`,
      sessionId: recipient.sessionId as string,
      bindingGeneration: recipient.bindingGeneration as number,
      mode,
      reason: `mailbox ${message.kind}`,
      causationId: message.id,
      content: [{ type: 'text', text: attributed }],
    })
  }

  async retryExpiredLeases(): Promise<MessageDelivery[]> {
    const snapshot = await this.snapshot()
    const candidates = snapshot.deliveries.filter((delivery) => delivery.state === 'leased' && delivery.claimedAt !== undefined && delivery.claimedAt + this.leaseMs <= this.now())
    const results: MessageDelivery[] = []
    for (const candidate of candidates) {
      try { results.push(await this.deliver(candidate.id)) } catch { /* failure is recorded by deliver */ }
    }
    return results
  }

  async retryDelivery(deliveryId: string): Promise<MessageDelivery> {
    await withProcessLock(this.lockFile, async () => {
      const snapshot = await this.readSnapshot()
      const index = snapshot.deliveries.findIndex((delivery) => delivery.id === deliveryId)
      if (index < 0) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, `unknown mailbox delivery "${deliveryId}"`)
      const current = snapshot.deliveries[index]
      if (current === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox delivery disappeared')
      if (current.state === 'delivered' || current.state === 'acknowledged') return
      if (current.state === 'leased' && current.claimedAt !== undefined && current.claimedAt + this.leaseMs > this.now()) return
      if (current.ackPolicy !== 'delivery' && current.ackPolicy !== 'formal' && current.ackPolicy !== 'consumption') throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'mailbox acknowledgement policy cannot be retried')
      const next: MessageDelivery = { ...current, state: 'stored', revision: current.revision + 1 }
      delete next.claimedAt
      delete next.deliveredAt
      delete next.acknowledgedAt
      delete next.failure
      snapshot.deliveries[index] = next
      await this.persist(snapshot)
    })
    return this.deliver(deliveryId)
  }

  async acknowledge(messageId: string, recipient: string, _formal = false): Promise<AcknowledgeResult> {
    if (text(messageId) === undefined || text(recipient) === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'acknowledgement requires messageId and recipient')
    let result: AcknowledgeResult | undefined
    await withProcessLock(this.lockFile, async () => {
      const snapshot = await this.readSnapshot()
      const index = snapshot.deliveries.findIndex((delivery) => delivery.messageId === messageId && delivery.recipient === recipient)
      if (index < 0) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'unknown mailbox delivery')
      const current = snapshot.deliveries[index]
      if (current === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox delivery disappeared')
      if (current.state === 'acknowledged' || (current.ackPolicy === 'delivery' && current.state === 'delivered')) { result = { delivery: cloneDelivery(current), duplicate: true }; return }
      if (current.state !== 'stored' && current.state !== 'delivered') throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'mailbox delivery is not acknowledgeable')
      if (current.ackPolicy === 'delivery') { result = { delivery: cloneDelivery(current), duplicate: true }; return }
      const next: MessageDelivery = { ...current, state: 'acknowledged', acknowledgedAt: this.now(), revision: current.revision + 1 }
      snapshot.deliveries[index] = next
      await this.persist(snapshot)
      await this.audit({ kind: 'delivery/acknowledged', teamId: this.teamId, deliveryId: next.id, messageId: next.messageId, recipient: next.recipient, actor: next.recipient, at: this.now(), revision: next.revision })
      result = { delivery: cloneDelivery(next), duplicate: false }
    })
    if (result === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'acknowledgement produced no result')
    return result
  }

  private async resolveFrom(actor: MailboxActor): Promise<TeamMessage['from']> {
    if (actor.type === 'human' || actor.type === 'scheduler') return actor.type
    if (this.resolveSessionSender === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'session sender resolver is unavailable')
    const memberId = await this.resolveSessionSender(actor.sessionId)
    if (memberId === undefined || memberId.length === 0) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'calling session is not bound to an active team member')
    return memberId
  }

  /**
   * A message persisted without its delivery rows is a message nobody will ever see: the snapshot is
   * two files, and a process that dies between them leaves exactly that. The reconciler calls this,
   * and the orphan becomes a visible failed delivery instead of silence (external review, mailbox
   * atomicity).
   */
  async healOrphanMessages(): Promise<{ messageId: string; recipient: string }[]> {
    let healed: { messageId: string; recipient: string }[] = []
    await withProcessLock(this.lockFile, async () => {
      const snapshot = await this.readSnapshot()
      const withDeliveries = new Set(snapshot.deliveries.map((delivery) => delivery.messageId))
      const orphans = snapshot.messages.filter((message) => !withDeliveries.has(message.id))
      if (orphans.length === 0) return
      const rows: MessageDelivery[] = orphans.map((message) => ({
        id: `delivery-${randomUUID()}`,
        messageId: message.id,
        recipient: message.to,
        wakePolicy: 'never',
        ackPolicy: 'delivery',
        state: 'failed',
        failure: 'the message was stored without a delivery row: the process stopped between the two writes',
        revision: snapshot.deliveries.length + 1,
      }))
      const next: MailboxSnapshot = { ...snapshot, deliveries: [...snapshot.deliveries, ...rows] }
      await atomicWriteJson(this.deliveriesFile, next)
      for (const row of rows) await this.audit({ kind: 'delivery/failed', teamId: this.teamId, deliveryId: row.id, messageId: row.messageId, recipient: row.recipient, reason: row.failure ?? 'orphan message', at: this.now(), revision: row.revision })
      healed = rows.map((row) => ({ messageId: row.messageId, recipient: row.recipient }))
    })
    return healed
  }

  private async markDelivered(deliveryId: string): Promise<MessageDelivery> {
    let result: MessageDelivery | undefined
    await withProcessLock(this.lockFile, async () => {
      const snapshot = await this.readSnapshot()
      const index = snapshot.deliveries.findIndex((delivery) => delivery.id === deliveryId)
      if (index < 0) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'unknown mailbox delivery')
      const current = snapshot.deliveries[index]
      if (current === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox delivery disappeared')
      if (current.state === 'delivered' || current.state === 'acknowledged') { result = cloneDelivery(current); return }
      if (current.state !== 'leased') throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'mailbox delivery lease is not held')
      const next: MessageDelivery = { ...current, state: 'delivered', deliveredAt: this.now(), revision: current.revision + 1 }
      delete next.failure
      snapshot.deliveries[index] = next
      await this.persist(snapshot)
      await this.audit({ kind: 'delivery/delivered', teamId: this.teamId, deliveryId: next.id, messageId: next.messageId, recipient: next.recipient, at: this.now(), revision: next.revision })
      result = cloneDelivery(next)
    })
    if (result === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'delivery transition produced no result')
    return result
  }

  private async fail(deliveryId: string, reason: string): Promise<MessageDelivery> {
    const failure = text(reason) ?? 'delivery failed'
    let result: MessageDelivery | undefined
    await withProcessLock(this.lockFile, async () => {
      const snapshot = await this.readSnapshot()
      const index = snapshot.deliveries.findIndex((delivery) => delivery.id === deliveryId)
      if (index < 0) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'unknown mailbox delivery')
      const current = snapshot.deliveries[index]
      if (current === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox delivery disappeared')
      if (current.state === 'delivered' || current.state === 'acknowledged') { result = cloneDelivery(current); return }
      const next: MessageDelivery = { ...current, state: 'failed', failure, revision: current.revision + 1 }
      snapshot.deliveries[index] = next
      await this.persist(snapshot)
      await this.audit({ kind: 'delivery/failed', teamId: this.teamId, deliveryId: next.id, messageId: next.messageId, recipient: next.recipient, reason: failure, at: this.now(), revision: next.revision })
      result = cloneDelivery(next)
    })
    if (result === undefined) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'failure transition produced no result')
    return result
  }

  private async snapshot(): Promise<MailboxSnapshot> { return withProcessLock(this.lockFile, () => this.readSnapshot()) }

  /**
   * Comments this member has not acknowledged, read synchronously.
   *
   * The membership context is assembled synchronously, and a comment is stored with
   * `wakePolicy: never` — nothing wakes the Session for it. Without a sync reader the recipient only
   * ever learns about a comment if it happens to ask (external review, finding 13).
   */
  unreadCommentsForSync(memberId: string): { from: string; content: string; at: number }[] {
    try {
      if (!existsSync(this.messagesFile) || !existsSync(this.deliveriesFile)) return []
      const messages = JSON.parse(readFileSync(this.messagesFile, 'utf8')) as { messages?: TeamMessage[] }
      const deliveries = JSON.parse(readFileSync(this.deliveriesFile, 'utf8')) as { deliveries?: MessageDelivery[] }
      const unread = new Set((deliveries.deliveries ?? [])
        .filter((delivery) => delivery.recipient === memberId && delivery.state !== 'acknowledged' && delivery.state !== 'failed')
        .map((delivery) => delivery.messageId))
      return (messages.messages ?? [])
        .filter((message) => message.kind === 'comment' && message.to === memberId && unread.has(message.id))
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(-3)
        .map((message) => ({ from: message.from, content: message.content, at: message.createdAt }))
    } catch { return [] }
  }

  private async readSnapshot(): Promise<MailboxSnapshot> {
    // The two files are published as a pair. One without the other is a torn
    // publication, and reading it as "no messages" would silently lose a send.
    const hasMessages = await fileExists(this.messagesFile)
    const hasDeliveries = await fileExists(this.deliveriesFile)
    if (hasMessages !== hasDeliveries) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox state is torn: only one of the two files exists')
    const messages = await this.readMessages()
    const deliveries = await this.readDeliveries()
    const ids = new Set(messages.map((message) => message.id))
    if (ids.size !== messages.length) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox contains duplicate message ids')
    const deliveryIds = new Set(deliveries.map((delivery) => delivery.id))
    if (deliveryIds.size !== deliveries.length) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox contains duplicate delivery ids')
    // One message reaches a given recipient once: the pair is the dedup key.
    const pairs = new Set(deliveries.map((delivery) => `${delivery.messageId}:${delivery.recipient}`))
    if (pairs.size !== deliveries.length) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox repeats a message for one recipient')
    if (deliveries.some((delivery) => !ids.has(delivery.messageId))) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox delivery references a missing message')
    return { messages, deliveries }
  }

  private async readMessages(): Promise<TeamMessage[]> {
    if (!(await fileExists(this.messagesFile))) return []
    let parsed: unknown
    try { parsed = await readJson(this.messagesFile) } catch (error) { throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox messages state is not readable JSON', { cause: error }) }
    return checkedArray(parsed, 'messages', this.teamId) as TeamMessage[]
  }

  private async readDeliveries(): Promise<MessageDelivery[]> {
    if (!(await fileExists(this.deliveriesFile))) return []
    let parsed: unknown
    try { parsed = await readJson(this.deliveriesFile) } catch (error) { throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'mailbox deliveries state is not readable JSON', { cause: error }) }
    return checkedArray(parsed, 'deliveries', this.teamId) as MessageDelivery[]
  }

  private async persist(snapshot: MailboxSnapshot): Promise<void> {
    // The lock covers both atomic publications. A message and every delivery row
    // are therefore durable before the queue/bridge is ever called by deliver().
    await atomicWriteJson(this.messagesFile, { schemaVersion: SCHEMA_VERSION, teamId: this.teamId, messages: snapshot.messages })
    await atomicWriteJson(this.deliveriesFile, { schemaVersion: SCHEMA_VERSION, teamId: this.teamId, deliveries: snapshot.deliveries })
  }

  private async audit(event: MailboxAuditEvent): Promise<void> { if (this.appendAudit !== undefined) await this.appendAudit(event) }
}

export type CreateMailboxOptions = MailboxOptions
export function createMailbox(options: MailboxOptions): MailboxService { return new MailboxService(options) }
export { messagePolicy }
