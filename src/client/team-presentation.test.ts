import { describe, expect, it } from 'vitest'
import { activityHeading, activityMatchesMode, memberTaskReferences, taskDecisionStage } from './team-presentation.js'
import type { TaskSummary, TeamJournalEntry } from './api.js'
const task: TaskSummary = { id: 't1', title: 'Evidence', status: 'waiting', awaitsDecision: true, assignee: 'worker', updatedAt: 1, route: { type: 'review', reviewer: 'reviewer' } }
describe('truthful Team presentation', () => {
 it('shortens only an exact typed suffix and leaves unknown narrative unchanged', () => {
  expect(activityHeading({ summary: 'Reviewer accepted · Evidence', refs: { taskTitle: 'Evidence' } }).summary).toBe('Reviewer accepted')
  expect(activityHeading({ summary: 'Evidence requires a decision, not acceptance', refs: { taskTitle: 'Evidence' } }).summary).toBe('Evidence requires a decision, not acceptance')
  expect(activityHeading({ summary: 'Source event', refs: {}, summaryParts: [{ text: 'Mismatched formatting' }] })).toEqual({ summary: 'Source event' })
 })
 it('names awaiting review without claiming Reviewer execution', () => {
  expect(taskDecisionStage(task)).toBe('taskAwaitingReview')
  expect(taskDecisionStage({ ...task, awaitsDecision: false })).toBeUndefined()
  expect(taskDecisionStage({ ...task, status: 'in_progress' })).toBeUndefined()
  expect(taskDecisionStage({ ...task, status: 'completed' })).toBeUndefined()
 })
 it('distinguishes a human report decision from an unspecified recipient', () => {
  expect(taskDecisionStage({ ...task, route: { type: 'report', to: 'human' } })).toBe('taskAwaitingHuman')
  expect(taskDecisionStage({ ...task, route: { type: 'custom', description: 'Undeclared policy' } })).toBe('taskAwaitingDecision')
 })
 it('shows only current assignment references, never fabricated activity', () => {
  expect(memberTaskReferences([task, { ...task, id: 'closed', status: 'completed' }, { ...task, id: 'archived', archivedPath: '/archive/x' }, { ...task, id: 'other', assignee: 'other' }], 'worker').map(t => t.id)).toEqual(['t1'])
 })
 it.each(['delivery', 'contact', 'other'] as const)('retains %s technical events without making normal noise important', category => {
  const row: Pick<TeamJournalEntry, 'kind' | 'category'> = { kind: 'delivery/queued', category }
  expect(activityMatchesMode(row, 'important')).toBe(false)
  expect(activityMatchesMode(row, 'all')).toBe(true)
  expect(activityMatchesMode(row, 'technical')).toBe(true)
  expect(activityMatchesMode({ ...row, kind: 'mailbox/delivery-failed' }, 'important')).toBe(true)
 })
 it.each(['task', 'review', 'message', 'team', 'member'] as const)('keeps meaningful %s metadata in important activity', category => {
  expect(activityMatchesMode({ category, kind: 'recorded' }, 'important')).toBe(true)
  expect(activityMatchesMode({ category, kind: 'recorded' }, 'technical')).toBe(false)
 })
})
