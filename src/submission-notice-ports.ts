import type { MailboxService, TeamMessage } from './mailbox.js'
import type { TaskStore, SubmissionNotificationRequest, SubmissionNotificationReceipt } from './task-store.js'
import { ERROR_CODES, LiveTeamsError } from './errors.js'

const PREFIX = 'submission-notice/v1:'
export type SubmissionNoticeFence = Pick<SubmissionNotificationRequest, 'taskId' | 'submissionId' | 'recipient' | 'purpose' | 'sessionId' | 'bindingGeneration'>
export function submissionNoticeThread(request: SubmissionNoticeFence): string {
  return PREFIX + Buffer.from(JSON.stringify([request.taskId, request.submissionId, request.recipient, request.purpose, request.sessionId, request.bindingGeneration])).toString('base64url')
}
export function submissionNoticeFence(message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>): SubmissionNoticeFence | undefined {
  if (message.from !== 'scheduler' || !message.threadId?.startsWith(PREFIX)) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(message.threadId.slice(PREFIX.length), 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 6 || ![value[0], value[1], value[2], value[4]].every(item => typeof item === 'string' && item.length > 0) || !['lead-acceptance', 'review'].includes(value[3]) || !Number.isSafeInteger(value[5]) || value[5] < 1 || message.to !== value[2]) throw new Error('invalid identity')
    return { taskId: value[0] as string, submissionId: value[1] as string, recipient: value[2] as string, purpose: value[3] as 'lead-acceptance' | 'review', sessionId: value[4] as string, bindingGeneration: value[5] as number }
  } catch { throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'invalid submission notification identity') }
}
export async function submissionNoticeDeliveryAllowed(store: Pick<TaskStore, 'isSubmissionNotificationCurrent'>, message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>, sessionId?: string, bindingGeneration?: number): Promise<boolean> {
  const fence = submissionNoticeFence(message)
  return fence === undefined || fence.sessionId === sessionId && fence.bindingGeneration === bindingGeneration && await store.isSubmissionNotificationCurrent(fence.taskId, fence.submissionId, fence.recipient, fence.purpose, sessionId, bindingGeneration)
}
export function createSubmissionNoticePort(options: { teamId: string; mailbox: () => Pick<MailboxService, 'sendFromSchedulerOnce'> | undefined }) {
  return async (request: SubmissionNotificationRequest): Promise<SubmissionNotificationReceipt> => {
    const base = { recipient: request.recipient, purpose: request.purpose }
    if (!await request.stillCurrent()) return { ...base, state: 'superseded', reason: 'submission-no-longer-current' }
    const mailbox = options.mailbox()
    if (mailbox === undefined) return { ...base, state: 'unavailable', reason: 'mailbox-unavailable' }
    const result = await mailbox.sendFromSchedulerOnce({ to: request.recipient, kind: 'message', threadId: submissionNoticeThread(request), content: `Сдача ожидает ${request.purpose === 'review' ? 'проверки назначенным Reviewer' : 'решения Lead о приёмке'}.\nЗадача: ${request.taskId}.\nSubmission: ${request.submissionId}.\nИсполнитель: ${request.assignee}.\nКратко: ${request.summary}\nСначала прочитай актуальную задачу и последнюю сдачу через live_team_read_task. Если сдача уже решена или заменена — игнорируй уведомление. Полные артефакты и проверки находятся в формальной сдаче. Это не приёмка и не разрешение менять контракт; сообщение-подтверждение не требуется.` })
    const delivery = result.deliveries.find(row => row.recipient === request.recipient)
    const ids = { messageId: result.message.id, requestId: `${options.teamId}:${result.message.id}:${request.recipient}:queue` }
    if (delivery === undefined) return { ...base, ...ids, state: 'failed', reason: 'missing-delivery-receipt' }
    if (delivery.state === 'failed') return await request.stillCurrent() ? { ...base, ...ids, state: 'failed', reason: 'delivery-failed' } : { ...base, ...ids, state: 'superseded', reason: 'submission-no-longer-current' }
    if (delivery.state === 'delivered' || delivery.state === 'acknowledged') return { ...base, ...ids, state: 'queued' }
    return { ...base, ...ids, state: 'pending', reason: 'delivery-in-progress' }
  }
}
