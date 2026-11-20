import type { TaskSummary, TeamJournalEntry } from './api.js'
import type { LocaleKey } from './locales.js'

/** Remove only an exact, typed task-title suffix. Never parse or rewrite event meaning. */
export function activityHeading(entry: { summary: string; refs: { taskTitle?: string }; summaryParts?: readonly { text: string; strong?: boolean }[] }): { summary: string; parts?: Array<{ text: string; strong?: boolean }> } {
  const suffix = entry.refs.taskTitle === undefined ? undefined : ` · ${entry.refs.taskTitle}`
  const summary = suffix !== undefined && entry.summary.endsWith(suffix) ? entry.summary.slice(0, -suffix.length) : entry.summary
  if (entry.summaryParts === undefined || entry.summaryParts.map(part => part.text).join('') !== entry.summary) return { summary }
  let remaining = summary.length
  const parts = entry.summaryParts.flatMap(part => { const text = part.text.slice(0, remaining); remaining = Math.max(0, remaining - text.length); return text.length === 0 ? [] : [{ ...part, text }] })
  return { summary, parts }
}

export type ActivityMode = 'important' | 'all' | 'technical'
type Activity = Pick<TeamJournalEntry, 'kind' | 'category'>

/** Classification uses formal event metadata, never private message text or inferred model intent. */
export function activityMatchesMode(entry: Activity, mode: ActivityMode): boolean {
  const technical = entry.category === 'delivery' || entry.category === 'contact' || entry.category === 'other'
  if (mode === 'all') return true
  if (mode === 'technical') return technical
  // Transport failures remain actionable even when ordinary queued/delivered rows are hidden.
  return !technical || /(?:^|[./_-])(failed|failure|error|rejected|blocked|unconfirmed|unavailable|stalled|intervened)(?:$|[./_-])/u.test(entry.kind)
}

/** A route tells us where the decision is expected, not whether that Session started working. */
export function taskDecisionStage(task: TaskSummary): LocaleKey | undefined {
  if (task.status !== 'waiting' || task.awaitsDecision !== true) return undefined
  if (task.route?.type === 'review') return 'taskAwaitingReview'
  if (task.route?.type === 'report' && task.route.to === 'human') return 'taskAwaitingHuman'
  return 'taskAwaitingDecision'
}

/** Assignment references only: a running Session is not proof of work on an assigned task. */
export function memberTaskReferences(tasks: readonly TaskSummary[], memberId: string): TaskSummary[] {
  return tasks.filter(task => task.assignee === memberId && task.archivedPath === undefined && !['completed', 'failed', 'cancelled'].includes(task.status))
}
