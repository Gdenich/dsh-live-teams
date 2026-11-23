import { ERROR_CODES, LiveTeamsError } from './errors.js'
import type { MailboxService, TeamMessage } from './mailbox.js'
import type { TaskStore, TeamTask, SubmissionNotificationReceipt } from './task-store.js'

export type LifecycleNoticeKind = 'review-verdict' | 'acceptance' | 'cancellation' | 'direction'
export interface LifecycleNoticeIntent {
 id: string; kind: LifecycleNoticeKind; contractRevision: number
 roundId?: string; submissionId?: string; assignee?: string; attemptId?: string; text?: string
 /** The lead this verdict was addressed to. Snapshotted so a later lead never inherits history. */
 leadMemberId?: string
}
export interface LifecycleNoticeRequest {
 taskId: string; intent: LifecycleNoticeIntent; recipient: string; sessionId: string; bindingGeneration: number; content: string
 stillCurrent: () => Promise<boolean>
}
export function lifecycleIntent(kind: LifecycleNoticeKind, contractRevision: number, fields: Omit<LifecycleNoticeIntent, 'id' | 'kind' | 'contractRevision'>): LifecycleNoticeIntent {
 return { id: `notice-${kind}:${fields.roundId ?? fields.submissionId ?? contractRevision}`, kind, contractRevision, ...fields }
}
export function withLifecycleIntent(task: TeamTask, intent: LifecycleNoticeIntent): TeamTask {
 return { ...task, lifecycleNotices: [...(task.lifecycleNotices ?? []).filter(value => value.kind !== intent.kind), intent] }
}
export function validateLifecycleNotices(value: unknown): asserts value is LifecycleNoticeIntent[] {
 if (!Array.isArray(value) || value.length > 4) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'invalid lifecycle notification intents')
 const kinds = new Set<string>()
 for (const item of value) {
  if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || !['review-verdict', 'acceptance', 'cancellation', 'direction'].includes(item.kind) || kinds.has(item.kind) || !Number.isSafeInteger(item.contractRevision) || item.contractRevision < 0) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'invalid lifecycle notification intent')
  kinds.add(item.kind)
  const fields = item.kind === 'review-verdict' ? ['roundId', 'submissionId'] : item.kind === 'acceptance' ? ['submissionId', 'assignee'] : item.kind === 'direction' ? ['assignee', 'attemptId', 'text'] : ['assignee', 'text']
  if (fields.some(key => typeof item[key] !== 'string' || !item[key])) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'incomplete lifecycle notification intent')
  if (item.leadMemberId !== undefined && (typeof item.leadMemberId !== 'string' || item.leadMemberId.length === 0)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'invalid lifecycle notification recipient')
 }
}
const PREFIX = 'lifecycle-notice/v1:'
export type LifecycleNoticeFence = { taskId: string; intentId: string; recipient: string; sessionId: string; bindingGeneration: number }
export function lifecycleNoticeThread(request: LifecycleNoticeRequest): string {
 return PREFIX + Buffer.from(JSON.stringify([request.taskId, request.intent.id, request.recipient, request.sessionId, request.bindingGeneration])).toString('base64url')
}
export function lifecycleNoticeFence(message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>): LifecycleNoticeFence | undefined {
 if (message.from !== 'scheduler' || !message.threadId?.startsWith(PREFIX)) return undefined
 try {
  if (message.threadId.length > 4096) throw new Error()
  const v: unknown = JSON.parse(Buffer.from(message.threadId.slice(PREFIX.length), 'base64url').toString('utf8'))
  if (!Array.isArray(v) || v.length !== 5 || !v.slice(0, 4).every(item => typeof item === 'string' && item.length > 0) || !Number.isSafeInteger(v[4]) || v[4] < 0 || v[2] !== message.to) throw new Error()
  return { taskId: v[0] as string, intentId: v[1] as string, recipient: v[2] as string, sessionId: v[3] as string, bindingGeneration: v[4] as number }
 } catch { throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'invalid lifecycle notice identity') }
}
export async function lifecycleNoticeDeliveryAllowed(store: Pick<TaskStore, 'isLifecycleNoticeCurrent'>, message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>, sessionId?: string, bindingGeneration?: number): Promise<boolean> {
 const f = lifecycleNoticeFence(message)
 return f === undefined || f.sessionId === sessionId && f.bindingGeneration === bindingGeneration && await store.isLifecycleNoticeCurrent(f)
}
export function createLifecycleNoticePort(options: { teamId: string; mailbox: () => Pick<MailboxService, 'sendFromSchedulerOnce'> | undefined }) {
 return async (request: LifecycleNoticeRequest): Promise<SubmissionNotificationReceipt> => {
  const base = { recipient: request.recipient, purpose: request.intent.kind }
  if (!await request.stillCurrent()) return { ...base, state: 'superseded', reason: 'lifecycle-action-no-longer-current' }
  const mailbox = options.mailbox()
  if (mailbox === undefined) return { ...base, state: 'unavailable', reason: 'mailbox-unavailable' }
  const result = await mailbox.sendFromSchedulerOnce({ to: request.recipient, kind: request.intent.kind === 'direction' ? 'direction' : 'message', threadId: lifecycleNoticeThread(request), content: request.content })
  const delivery = result.deliveries.find(row => row.recipient === request.recipient)
  const ids = { messageId: result.message.id, requestId: `${options.teamId}:${result.message.id}:${request.recipient}:queue` }
  if (delivery === undefined) return { ...base, ...ids, state: 'failed', reason: 'missing-delivery-receipt' }
  if (delivery.state === 'failed') return await request.stillCurrent() ? { ...base, ...ids, state: 'failed', reason: 'delivery-failed' } : { ...base, ...ids, state: 'superseded', reason: 'lifecycle-action-no-longer-current' }
  return { ...base, ...ids, state: delivery.state === 'delivered' || delivery.state === 'acknowledged' ? 'queued' : 'pending' }
 }
}
