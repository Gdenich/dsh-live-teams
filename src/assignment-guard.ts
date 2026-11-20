import { LiveTeamsError, ERROR_CODES } from './errors.js'
import type { TaskStore } from './task-store.js'
import type { TeamMessage } from './mailbox.js'

export function assignmentFence(message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>): { taskId: string; attemptId: string; assignee: string } | undefined {
  if (message.from !== 'scheduler' || !message.threadId?.startsWith('dispatch:')) return undefined
  const match = /^dispatch:([^:]+):([^:]+)$/.exec(message.threadId)
  if (match === null || message.to === 'team' || message.to === 'human') throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, 'invalid scheduler assignment identity')
  return { taskId: match[1]!, attemptId: match[2]!, assignee: message.to }
}

/** Inspect durable ownership, not prose or an Agent's generic running flag. */
export async function assignmentDeliveryAllowed(store: Pick<TaskStore, 'listTasks' | 'readAttempts'>, message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>, sessionId?: string, bindingGeneration?: number): Promise<boolean> {
  const fence = assignmentFence(message)
  if (fence === undefined) return true
  const tasks = await store.listTasks({ includeArchived: true })
  const task = tasks.find(entry => entry.id === fence.taskId)
  if (task === undefined || task.archivedPath !== undefined || !['claimed', 'in_progress'].includes(task.status) || task.latestSubmissionId !== undefined || task.assignee !== fence.assignee || task.activeAttemptId !== fence.attemptId) return false
  const attempt = (await store.readAttempts()).attempts.find(entry => entry.id === fence.attemptId)
  return attempt?.status === 'active' && attempt.taskId === task.id && attempt.memberId === fence.assignee && attempt.sessionId === sessionId && attempt.bindingGeneration === bindingGeneration
}
