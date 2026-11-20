import { describe, expect, it, vi } from 'vitest'
import { createAssignmentRecovery } from './assignment-recovery.js'
import type { TeamTask, TaskAttempt } from './task-store.js'
const task: TeamTask = { id: 'task1', teamId: 'team-1', title: 'Work', kind: 'work', status: 'completed', assignee: 'worker', activeAttemptId: 'attempt1', acceptance: ['Done'], roundLimit: 3, createdBy: 'lead', createdAt: 1, updatedAt: 2, revision: 2 }
const attempt: TaskAttempt = { id: 'attempt1', taskId: 'task1', memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, generation: 1, status: 'completed', startedAt: 1, revision: 2 }
function fixture(status: TeamTask['status'] = 'completed') {
  const removeQueuedRequest = vi.fn(async () => ({ state: 'removed' as const, itemId: 'queued1' }))
  const audit = vi.fn(async (_value: unknown) => undefined)
  const recovery = createAssignmentRecovery({ teamId: 'team-1', store: { listTasks: async () => [{ ...task, status }], readAttempts: async () => ({ schemaVersion: 1, teamId: 'team-1', revision: 2, attempts: [{ ...attempt, status: status === 'claimed' ? 'active' : 'completed' }] }) }, bridge: { removeQueuedRequest }, listMessages: async () => [{ id: 'message1', teamId: 'team-1', from: 'scheduler', to: 'worker', kind: 'message', content: 'private body is not logged', createdAt: 1, threadId: 'dispatch:task1:attempt1' }], listCommands: async () => [{ causationId: 'message1', requestId: 'team-1:message1:worker:queue', sessionId: 's-worker', bindingGeneration: 1, mode: 'queue' }], appendAudit: audit })
  return { recovery, removeQueuedRequest, audit }
}
describe('obsolete accepted assignment reconciliation', () => {
  it('removes obsolete input exactly once and records only operational metadata', async () => {
    const f = fixture()
    await f.recovery(); await f.recovery()
    expect(f.removeQueuedRequest).toHaveBeenCalledOnce()
    expect(f.removeQueuedRequest).toHaveBeenCalledWith('s-worker', 'team-1:message1:worker:queue')
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispatch/obsolete-input', state: 'removed', taskId: 'task1' }))
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('private body')
  })
  it('preserves still-current queued ownership', async () => {
    const f = fixture('claimed')
    await f.recovery()
    expect(f.removeQueuedRequest).not.toHaveBeenCalled()
  })
})
