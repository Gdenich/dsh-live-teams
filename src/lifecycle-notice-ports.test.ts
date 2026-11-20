import { describe, expect, it, vi } from 'vitest'
import { createLifecycleNoticePort, lifecycleIntent, lifecycleNoticeDeliveryAllowed } from './lifecycle-notice.js'
import type { LifecycleNoticeRequest } from './lifecycle-notice.js'
import type { MessageDraft, SendResult } from './mailbox.js'
const request = (): LifecycleNoticeRequest => ({ taskId: 't1', intent: lifecycleIntent('review-verdict', 2, { roundId: 'r1', submissionId: 'sub1' }), recipient: 'lead', sessionId: 's-lead', bindingGeneration: 1, content: 'Formal PASS is recorded. Read task; do not accept twice.', stillCurrent: async () => true })
function fixture(state: 'delivered' | 'leased' | 'stored' | 'failed' = 'delivered') {
 const sendFromSchedulerOnce = vi.fn(async (draft: MessageDraft): Promise<SendResult> => ({ message: { ...draft, from: 'scheduler', id: 'notice1', teamId: 'team-1', createdAt: 1 }, deliveries: [{ id: 'delivery1', messageId: 'notice1', recipient: 'lead', wakePolicy: 'queue', ackPolicy: 'delivery', state, revision: 1 }] }))
 return { sendFromSchedulerOnce, port: createLifecycleNoticePort({ teamId: 'team-1', mailbox: () => ({ sendFromSchedulerOnce }) }) }
}
describe('lifecycle production ports', () => {
 it.each([['delivered', 'queued'], ['leased', 'pending'], ['stored', 'pending'], ['failed', 'failed']] as const)('reports %s honestly as %s', async (delivery, state) => {
  const f = fixture(delivery); expect(await f.port(request())).toMatchObject({ recipient: 'lead', purpose: 'review-verdict', state, messageId: 'notice1', requestId: 'team-1:notice1:lead:queue' })
 })
 it('keeps canonical identity across repair and fences current task outcome and native binding', async () => {
  const f = fixture(); const r = request(); await f.port(r); await f.port(request())
  expect(f.sendFromSchedulerOnce.mock.calls[0]![0]).toEqual(f.sendFromSchedulerOnce.mock.calls[1]![0])
  const message = { from: 'scheduler', to: 'lead', threadId: f.sendFromSchedulerOnce.mock.calls[0]![0].threadId! }; const store = { isLifecycleNoticeCurrent: vi.fn(async () => true) }
  expect(await lifecycleNoticeDeliveryAllowed(store, message, 's-lead', 1)).toBe(true)
  expect(await lifecycleNoticeDeliveryAllowed(store, message, 's-other', 1)).toBe(false)
  expect(await lifecycleNoticeDeliveryAllowed(store, message, 's-lead', 2)).toBe(false)
  store.isLifecycleNoticeCurrent.mockResolvedValue(false)
  expect(await lifecycleNoticeDeliveryAllowed(store, message, 's-lead', 1)).toBe(false)
  expect(await lifecycleNoticeDeliveryAllowed(store, { from: 'worker', to: 'lead' }, 's-other', 2)).toBe(true)
 })
 it('refuses malformed scheduler identities and avoids sending unavailable/stale capabilities', async () => {
  await expect(lifecycleNoticeDeliveryAllowed({ isLifecycleNoticeCurrent: async () => true }, { from: 'scheduler', to: 'lead', threadId: 'lifecycle-notice/v1:invalid' }, 's-lead', 1)).rejects.toThrow()
  const f = fixture(); const r = request(); r.stillCurrent = async () => false
  expect(await f.port(r)).toMatchObject({ state: 'superseded' }); expect(f.sendFromSchedulerOnce).not.toHaveBeenCalled()
  expect(await createLifecycleNoticePort({ teamId: 'team-1', mailbox: () => undefined })(request())).toMatchObject({ state: 'unavailable' })
 })
})
