import type { SubmissionNotificationReceipt } from './task-store.js'

export const REVIEW_RETURN_STATES = ['pending', 'sending', 'delivered', 'started', 'completed', 'blocked', 'failed', 'unconfirmed', 'superseded'] as const
export interface ReviewReturn {
  roundId: string
  submissionId: string
  attemptId: string
  generation: number
  assignee: string
  sessionId: string
  bindingGeneration: number
  state: typeof REVIEW_RETURN_STATES[number]
  at: number
  reason?: string
  messageId?: string
  requestId?: string
  admission?: 'queued' | 'pending'
  turn?: number
  inputSeq?: number
  leadNotified?: boolean
  leadNotification?: SubmissionNotificationReceipt
}

/** Semantic notification budget; raw state transitions remain in audit/GUI. */
export function reviewReturnNoticeClass(intent: Pick<ReviewReturn, 'state' | 'reason'>): string | undefined {
  if (intent.state === 'started' || intent.state === 'completed') return 'returned'
  if (intent.state === 'blocked' || intent.state === 'failed') return `problem:${intent.state}:${intent.reason ?? 'unknown'}`
  if (intent.state === 'superseded' && ['dispatch-paused', 'team-disabled', 'human-intervened', 'integration-pending', 'member-unavailable', 'binding-changed', 'dependency-not-completed', 'paths-overlap'].includes(intent.reason ?? '')) return `problem:blocked:${intent.reason}`
  if (intent.state === 'unconfirmed' && ['execution-unobservable', 'observation-failed', 'invalid-execution-receipt', 'delivery-unavailable'].includes(intent.reason ?? '')) return `problem:unobservable:${intent.reason}`
  return undefined
}

/** Whitelist operational metadata; never expose arbitrary source/message bodies. */
export function parseReviewReturn(value: unknown): ReviewReturn {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid review return metadata')
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of ['roundId', 'submissionId', 'attemptId', 'assignee', 'sessionId'] as const) {
    if (typeof record[key] !== 'string' || record[key].length === 0) throw new Error('invalid review return identity')
    result[key] = record[key]
  }
  for (const [key, minimum] of [['generation', 1], ['bindingGeneration', 0], ['at', 0]] as const) {
    if (!Number.isSafeInteger(record[key]) || Number(record[key]) < minimum) throw new Error('invalid review return counter')
    result[key] = record[key]
  }
  if (!REVIEW_RETURN_STATES.includes(record.state as ReviewReturn['state'])) throw new Error('invalid review return state')
  result.state = record.state
  for (const key of ['reason', 'messageId', 'requestId'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string' || record[key].length === 0) throw new Error('invalid review return text')
      result[key] = record[key]
    }
  }
  if (record.admission !== undefined) {
    if (!['queued', 'pending'].includes(String(record.admission)) || record.requestId === undefined) throw new Error('invalid review return admission receipt')
    result.admission = record.admission
  }
  if ((record.messageId === undefined) !== (record.requestId === undefined)) throw new Error('incomplete review return delivery identity')
  for (const key of ['turn', 'inputSeq'] as const) {
    if (record[key] !== undefined) {
      if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0) throw new Error('invalid review return execution metadata')
      result[key] = record[key]
    }
  }
  if (['delivered', 'started', 'completed'].includes(String(record.state)) && record.requestId === undefined) throw new Error('review return has no request receipt')
  if (['started', 'completed'].includes(String(record.state)) && (record.turn === undefined || record.inputSeq === undefined)) throw new Error('review return has no turn receipt')
  if (record.leadNotified !== undefined) {
    if (typeof record.leadNotified !== 'boolean') throw new Error('invalid review return notice flag')
    result.leadNotified = record.leadNotified
  }
  if (record.leadNotification !== undefined) {
    const receipt = record.leadNotification as Record<string, unknown>
    if (receipt === null || typeof receipt !== 'object' || receipt.purpose !== 'review-return-lead' || typeof receipt.recipient !== 'string' || !receipt.recipient || !['queued', 'pending', 'failed', 'unavailable', 'superseded'].includes(String(receipt.state))) throw new Error('invalid review return lead receipt')
    const safe: Record<string, unknown> = { recipient: receipt.recipient, purpose: receipt.purpose, state: receipt.state }
    for (const key of ['messageId', 'requestId', 'reason']) if (receipt[key] !== undefined) {
      if (typeof receipt[key] !== 'string' || !receipt[key]) throw new Error('invalid review return lead receipt identity')
      safe[key] = receipt[key]
    }
    if (receipt.state === 'queued' && (!safe.messageId || !safe.requestId)) throw new Error('missing review return lead admission receipt')
    if (receipt.sessionId !== undefined || receipt.bindingGeneration !== undefined) {
      if (typeof receipt.sessionId !== 'string' || !receipt.sessionId || !Number.isSafeInteger(receipt.bindingGeneration) || Number(receipt.bindingGeneration) < 0) throw new Error('invalid review return lead binding')
      safe.sessionId = receipt.sessionId; safe.bindingGeneration = receipt.bindingGeneration
    }
    result.leadNotification = safe
  }
  return result as unknown as ReviewReturn
}
