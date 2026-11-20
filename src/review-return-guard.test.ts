import { describe, expect, it, vi } from 'vitest'
import { createReviewReturnGuard } from './review-return-guard.js'
import { reviewReturnThread } from './review-return-ports.js'
import type { ReviewReturnRequest, TaskAttempt } from './task-store.js'

const request: ReviewReturnRequest = { taskId: 'task1', title: 'Work', leadMemberId: 'lead', intent: { roundId: 'r1', submissionId: 'sub1', attemptId: 'a1', generation: 1, assignee: 'worker', sessionId: 's-worker', bindingGeneration: 1, state: 'sending', at: 1 }, round: { id: 'r1', taskId: 'task1', submissionId: 'sub1', reviewerMemberId: 'reviewer', round: 1, verdict: 'needs_revision', findings: [], evidence: [], createdAt: 1, revision: 1 }, stillCurrent: async () => true }
const message = { from: 'scheduler', threadId: reviewReturnThread(request) }
function fixture(observed: boolean | undefined, events: unknown[] = []) {
  const isReviewReturnCurrent = vi.fn(async () => true)
  const blockReviewReturn = vi.fn(async () => undefined)
  const attempt: TaskAttempt = { id: 'a1', taskId: 'task1', memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, generation: 1, status: 'active', startedAt: 10, revision: 1 }
  const observeHumanActivity = vi.fn(async () => observed)
  const guard = createReviewReturnGuard({ store: { isReviewReturnCurrent, blockReviewReturn, readAttempts: async () => ({ schemaVersion: 1, teamId: 'team-1', revision: 1, attempts: [attempt] }) }, bridge: { observeHumanActivity }, readEvents: async () => events, knownRequestIds: async () => ['team-command'] })
  return { guard, blockReviewReturn, isReviewReturnCurrent, observeHumanActivity }
}
describe('fresh automatic-return authority fence', () => {
  it.each([true, undefined])('blocks rather than assumes authority when direct input is %s', async observed => {
    const f = fixture(observed)
    expect(await f.guard(message, 's-worker', 1)).toBe(false)
    expect(f.blockReviewReturn).toHaveBeenCalledWith('task1', expect.objectContaining({ roundId: 'r1' }), observed === true ? 'human-intervened' : 'intervention-unobservable')
  })
  it('uses only a formal explicit return as the human-resolution boundary, not ordinary task timestamps', async () => {
    const f = fixture(false, [{ kind: 'task/revised', taskId: 'task1', at: 20 }, { kind: 'review/round', taskId: 'task1', at: 100 }, { kind: 'task/revised', taskId: 'other', at: 200 }])
    expect(await f.guard(message, 's-worker', 1)).toBe(true)
    expect(f.observeHumanActivity).toHaveBeenCalledWith('s-worker', 20, ['team-command'])
    expect(f.blockReviewReturn).not.toHaveBeenCalled()
  })
  it('rechecks cancellation or pause after the async inspection', async () => {
    const f = fixture(false)
    f.isReviewReturnCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await f.guard(message, 's-worker', 1)).toBe(false)
  })
  it('does not inspect direct human or ordinary peer messages as automatic review returns', async () => {
    const f = fixture(true)
    expect(await f.guard({ from: 'human', threadId: message.threadId }, 's-worker', 1)).toBe(true)
    expect(f.observeHumanActivity).not.toHaveBeenCalled()
  })
})
