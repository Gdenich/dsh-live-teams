import { describe, expect, it, vi } from 'vitest'
import { createSubmissionNoticePort, submissionNoticeFence } from './submission-notice-ports.js'
import type { SubmissionNotificationRequest } from './task-store.js'
import type { MessageDraft, SendResult } from './mailbox.js'
const request = (): SubmissionNotificationRequest => ({ taskId: 't1', submissionId: 'sub1', assignee: 'worker', summary: 'Готово; evidence stays formal', recipient: 'lead', purpose: 'lead-acceptance', sessionId: 's-lead', bindingGeneration: 1, stillCurrent: async () => true })
function fixture(state: 'delivered' | 'leased' | 'failed' = 'delivered') {
 const sendFromSchedulerOnce = vi.fn(async (draft: MessageDraft): Promise<SendResult> => ({ message: { ...draft, from: 'scheduler', id: 'notice1', teamId: 'team-1', createdAt: 1 }, deliveries: [{ id: 'delivery1', messageId: 'notice1', recipient: 'lead', wakePolicy: 'queue', ackPolicy: 'delivery', state, revision: 1, ...(state === 'delivered' ? { deliveredAt: 1 } : state === 'leased' ? { claimedAt: 1 } : { failure: 'private diagnostic' }) }] }))
 return { sendFromSchedulerOnce, port: createSubmissionNoticePort({ teamId: 'team-1', mailbox: () => ({ sendFromSchedulerOnce }) }) }
}
describe('canonical submission notification outbox', () => {
 it('uses one stable capability identity and reports admission, not execution', async () => {
  const f = fixture(); const r = request(); const first = await f.port(r); const second = await f.port(r)
  expect(first).toMatchObject({ recipient: 'lead', purpose: 'lead-acceptance', state: 'queued', messageId: 'notice1', requestId: 'team-1:notice1:lead:queue' })
  expect(second).toEqual(first)
  expect(f.sendFromSchedulerOnce.mock.calls[0]![0]).toEqual(f.sendFromSchedulerOnce.mock.calls[1]![0])
  expect(submissionNoticeFence({ from: 'scheduler', to: 'lead', threadId: f.sendFromSchedulerOnce.mock.calls[0]![0].threadId! })).toMatchObject({ taskId: 't1', submissionId: 'sub1', recipient: 'lead', sessionId: 's-lead', bindingGeneration: 1 })
 })
 it.each([['leased', 'pending'], ['failed', 'failed']] as const)('does not call %s delivery accepted', async (delivery, expected) => {
  const f = fixture(delivery); expect(await f.port(request())).toMatchObject({ state: expected }); expect(JSON.stringify(await f.port(request()))).not.toContain('private diagnostic')
 })
 it('does not send after the submission becomes stale', async () => {
  const f = fixture(); const r = request(); r.stillCurrent = async () => false
  expect(await f.port(r)).toMatchObject({ state: 'superseded' }); expect(f.sendFromSchedulerOnce).not.toHaveBeenCalled()
 })
})
