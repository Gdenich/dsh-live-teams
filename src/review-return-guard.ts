import type { TaskStore } from './task-store.js'
import type { SessionBridge } from './session-bridge.js'
import type { TeamMessage } from './mailbox.js'
import { reviewReturnDeliveryAllowed, reviewReturnFence } from './review-return-ports.js'

/** Fresh authority observation outside every persistence lock, immediately before enqueue. */
export function createReviewReturnGuard(deps: {
  store: Pick<TaskStore, 'isReviewReturnCurrent' | 'readAttempts' | 'blockReviewReturn'>
  bridge: Pick<SessionBridge, 'observeHumanActivity'>
  readEvents: () => Promise<readonly unknown[]>
  knownRequestIds: (sessionId: string) => Promise<readonly string[]>
}) {
  return async (message: Pick<TeamMessage, 'from' | 'threadId'>, sessionId?: string, bindingGeneration?: number): Promise<boolean> => {
    if (!await reviewReturnDeliveryAllowed(deps.store, message, sessionId, bindingGeneration)) return false
    const fence = reviewReturnFence(message)
    if (fence === undefined) return true
    const attempt = (await deps.store.readAttempts()).attempts.find(entry => entry.id === fence.attemptId && entry.generation === fence.generation && entry.sessionId === fence.sessionId)
    if (attempt === undefined) return false
    // A formal explicit return resolves earlier intervention; later direct human input does not.
    // Audit times, not mutable task.updatedAt, delimit that authority boundary.
    let since = attempt.startedAt
    for (const raw of await deps.readEvents()) {
      if (raw === null || typeof raw !== 'object') continue
      const event = raw as Record<string, unknown>
      if (event.kind === 'task/revised' && event.taskId === fence.taskId && typeof event.at === 'number' && Number.isFinite(event.at)) since = Math.max(since, event.at)
    }
    const observed = await deps.bridge.observeHumanActivity(fence.sessionId, since, await deps.knownRequestIds(fence.sessionId))
    if (observed !== false) {
      const { taskId, ...identity } = fence
      await deps.store.blockReviewReturn(taskId, identity, observed === true ? 'human-intervened' : 'intervention-unobservable')
      return false
    }
    // Observation itself is async: recheck pause/cancellation/binding after it, too.
    return reviewReturnDeliveryAllowed(deps.store, message, sessionId, bindingGeneration)
  }
}
