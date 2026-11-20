import { describe, expect, it, vi } from 'vitest'
import { createReviewReturnPorts, reviewReturnLeadDeliveryAllowed, reviewReturnDeliveryAllowed, reviewReturnFence, reviewReturnThread } from './review-return-ports.js'
import type { ReviewReturnRequest } from './task-store.js'
import type { MessageDraft, SendResult } from './mailbox.js'

function fixture() {
  const request: ReviewReturnRequest = { taskId: 't1', title: 'Исправление', leadMemberId: 'lead', leadSessionId: 's-lead', leadBindingGeneration: 1, leadStillCurrent: async () => true, intent: { roundId: 'r1', submissionId: 'sub1', attemptId: 'a1', generation: 1, assignee: 'worker', sessionId: 's-worker', bindingGeneration: 1, state: 'sending', at: 1 }, round: { id: 'r1', taskId: 't1', submissionId: 'sub1', reviewerMemberId: 'reviewer', verdict: 'needs_revision', round: 1, findings: [{ severity: 'medium', problem: 'Граница диапазона', requiredFix: 'Исправить\nНе менять контракт.' }], evidence: [], createdAt: 1, revision: 1 }, stillCurrent: vi.fn(async () => true) }
  const sendFromSchedulerOnce = vi.fn(async (draft: MessageDraft): Promise<SendResult> => ({ message: { ...draft, id: 'm1', teamId: 'team-1', from: 'scheduler', createdAt: 1 }, deliveries: [{ id: 'd1', messageId: 'm1', recipient: draft.to, wakePolicy: 'queue', ackPolicy: 'delivery', state: 'delivered', deliveredAt: 1, revision: 3 }] }))
  const observeRequest = vi.fn(async () => ({ state: 'started' as const, turn: 1, inputSeq: 2 }))
  const ports = createReviewReturnPorts({ mailbox: () => ({ sendFromSchedulerOnce }), bridge: { observeRequest }, teamId: 'team-1', observationTimeoutMs: 0 })
  return { request, sendFromSchedulerOnce, observeRequest, ports }
}

describe('quiet return notice budget', () => {
  it('returns explicit Lead admission proof and fences semantic notices to current binding', async () => {
    const f = fixture(); f.request.intent.state = 'started'
    expect(await f.ports.notifyReviewReturn(f.request)).toMatchObject({ recipient: 'lead', purpose: 'review-return-lead', state: 'queued', requestId: 'team-1:m1:lead:queue', sessionId: 's-lead', bindingGeneration: 1 })
    const draft = f.sendFromSchedulerOnce.mock.calls[0]![0]; const message = { from: 'scheduler', to: 'lead', threadId: draft.threadId! }
    const store = { isReviewReturnLeadCurrent: vi.fn(async () => true) }
    expect(await reviewReturnLeadDeliveryAllowed(store, message, 's-lead', 1)).toBe(true)
    expect(await reviewReturnLeadDeliveryAllowed(store, message, 's-other', 1)).toBe(false)
    expect(await reviewReturnLeadDeliveryAllowed(store, message, 's-lead', 2)).toBe(false)
    store.isReviewReturnLeadCurrent.mockResolvedValue(false)
    expect(await reviewReturnLeadDeliveryAllowed(store, message, 's-lead', 1)).toBe(false)
  })
  it('does not claim Lead notification for an absent binding or stale semantic capability', async () => {
    const f = fixture(); f.request.intent.state = 'started'; delete f.request.leadSessionId
    expect(await f.ports.notifyReviewReturn(f.request)).toMatchObject({ state: 'unavailable' })
    f.request.leadSessionId = 's-lead'; f.request.leadStillCurrent = async () => false
    expect(await f.ports.notifyReviewReturn(f.request)).toMatchObject({ state: 'superseded' })
    expect(f.sendFromSchedulerOnce).not.toHaveBeenCalled()
  })
  it('keeps an actionable late pause visible instead of treating it as ordinary supersession', async () => {
    const f = fixture(); f.request.intent.state = 'superseded'; f.request.intent.reason = 'dispatch-paused'
    await f.ports.notifyReviewReturn(f.request)
    expect(f.sendFromSchedulerOnce).toHaveBeenCalledOnce()
    expect(f.sendFromSchedulerOnce.mock.calls[0]![0].content).toContain('требует решения')
  })
  it('uses one canonical outcome identity/content for started and completed processing', async () => {
    const f = fixture()
    f.request.intent.state = 'started'
    await f.ports.notifyReviewReturn(f.request)
    f.request.intent.state = 'completed'
    await f.ports.notifyReviewReturn(f.request)
    const first = f.sendFromSchedulerOnce.mock.calls[0]![0]
    const second = f.sendFromSchedulerOnce.mock.calls[1]![0]
    expect(second.threadId).toBe(first.threadId)
    expect(second.content).toBe(first.content)
  })
  it.each(['pending', 'sending', 'delivered', 'unconfirmed', 'superseded'] as const)('does not wake the lead for bookkeeping %s', async state => {
    const f = fixture(); f.request.intent.state = state
    f.request.intent.reason = state === 'superseded' ? 'new-submission' : 'execution-not-yet-observed'
    await f.ports.notifyReviewReturn(f.request)
    expect(f.sendFromSchedulerOnce).not.toHaveBeenCalled()
  })
})

describe('production review return ports', () => {
  it('queues readable findings using a stable fence and the real command request identity', async () => {
    const f = fixture()
    const receipt = await f.ports.deliverReviewReturn(f.request)
    expect(receipt).toEqual({ messageId: 'm1', requestId: 'team-1:m1:worker:queue', pending: false })
    const draft = f.sendFromSchedulerOnce.mock.calls[0]![0]
    expect(draft.content).toContain('Исправить\nНе менять контракт.')
    expect(reviewReturnFence({ from: 'scheduler', threadId: draft.threadId! })).toMatchObject({ taskId: 't1', attemptId: 'a1', sessionId: 's-worker', generation: 1 })
    f.request.intent.requestId = receipt.requestId
    expect(await f.ports.observeReviewReturn(f.request)).toMatchObject({ state: 'started', inputSeq: 2 })
    expect(f.observeRequest).toHaveBeenCalledWith('s-worker', receipt.requestId)
  })
  it('does not enqueue when capability has changed', async () => {
    const f = fixture(); f.request.stillCurrent = async () => false
    await expect(f.ports.deliverReviewReturn(f.request)).rejects.toThrow()
    expect(f.sendFromSchedulerOnce).not.toHaveBeenCalled()
  })
  it('distinguishes a held delivery lease from accepted delivery', async () => {
    const f = fixture()
    f.sendFromSchedulerOnce.mockImplementation(async draft => ({ message: { ...draft, id: 'm1', teamId: 'team-1', from: 'scheduler', createdAt: 1 }, deliveries: [{ id: 'd1', messageId: 'm1', recipient: 'worker', state: 'leased', claimedAt: 1, revision: 2, wakePolicy: 'queue', ackPolicy: 'delivery' }] }))
    expect(await f.ports.deliverReviewReturn(f.request)).toMatchObject({ pending: true })
  })
  it('does not confuse completed request processing with acceptance of work', async () => {
    const f = fixture(); f.request.intent.state = 'completed'
    await f.ports.notifyReviewReturn(f.request)
    expect(f.sendFromSchedulerOnce.mock.calls[0]![0].content).toContain('это не принятие задачи')
  })
  it('fences background retries against changed bindings and current attempt authority', async () => {
    const f = fixture(); const store = { isReviewReturnCurrent: vi.fn(async () => false) }
    const message = { from: 'scheduler', threadId: reviewReturnThread(f.request) }
    expect(await reviewReturnDeliveryAllowed(store, message, 's-worker', 1)).toBe(false)
    store.isReviewReturnCurrent.mockResolvedValue(true)
    expect(await reviewReturnDeliveryAllowed(store, message, 's-other', 1)).toBe(false)
    expect(await reviewReturnDeliveryAllowed(store, message, 's-worker', 2)).toBe(false)
    expect(await reviewReturnDeliveryAllowed(store, message, 's-worker', 1)).toBe(true)
    expect(await reviewReturnDeliveryAllowed(store, { from: 'worker', threadId: message.threadId }, 's-other', 2)).toBe(true)
  })
  it('rejects malformed scheduler fences rather than treating them as ordinary traffic', () => {
    expect(() => reviewReturnFence({ from: 'scheduler', threadId: 'review-return/v1:invalid' })).toThrow()
  })
})
