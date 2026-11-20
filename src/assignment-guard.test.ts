import { describe, expect, it } from 'vitest'
import { assignmentDeliveryAllowed } from './assignment-guard.js'
import type { TeamTask, TaskAttempt } from './task-store.js'
const task: TeamTask = { id: 'task-1', teamId: 'team-1', title: 'Work', kind: 'work', status: 'claimed', assignee: 'worker', activeAttemptId: 'attempt-1', acceptance: ['Done'], roundLimit: 3, createdBy: 'lead', createdAt: 1, updatedAt: 1, revision: 1 }
const attempt: TaskAttempt = { id: 'attempt-1', taskId: 'task-1', memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, generation: 1, status: 'active', startedAt: 1, revision: 1 }
const message = { from: 'scheduler', to: 'worker', threadId: 'dispatch:task-1:attempt-1' }
const store = (t = task, a = attempt) => ({ listTasks: async () => [t], readAttempts: async () => ({ schemaVersion: 1, teamId: 'team-1', revision: 1, attempts: [a] }) })
describe('scheduler assignment freshness', () => {
  it('permits the matching active assignment only', async () => {
    expect(await assignmentDeliveryAllowed(store(), message, 's-worker', 1)).toBe(true)
    expect(await assignmentDeliveryAllowed(store(), message, 's-other', 1)).toBe(false)
    expect(await assignmentDeliveryAllowed(store(), message, 's-worker', 2)).toBe(false)
  })
  it.each(['completed', 'cancelled', 'failed', 'draft', 'ready', 'waiting', 'needs_human'] as const)('refuses %s task assignments', async status => {
    expect(await assignmentDeliveryAllowed(store({ ...task, status }), message, 's-worker', 1)).toBe(false)
  })
  it('refuses archived, replaced, submitted and revoking assignments', async () => {
    for (const patch of [{ archivedPath: 'archive/old.md' }, { activeAttemptId: 'new-attempt' }, { latestSubmissionId: 'sub1' }, { assignee: 'someone-else' }]) expect(await assignmentDeliveryAllowed(store({ ...task, ...patch }), message, 's-worker', 1)).toBe(false)
    expect(await assignmentDeliveryAllowed(store(task, { ...attempt, status: 'revoking' }), message, 's-worker', 1)).toBe(false)
  })
  it('does not classify peer messages as scheduler assignment authority', async () => {
    expect(await assignmentDeliveryAllowed(store({ ...task, status: 'completed' }), { ...message, from: 'peer' }, 's-worker', 1)).toBe(true)
  })
})
