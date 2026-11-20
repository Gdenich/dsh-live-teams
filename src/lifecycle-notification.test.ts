import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TeamStore } from './team-store.js'
import { createTaskStore, type SubmissionNotificationReceipt } from './task-store.js'
import type { LifecycleNoticeRequest } from './lifecycle-notice.js'

async function fixture(review = true) {
 const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-lifecycle-'))
 const team = new TeamStore({ workspacePath, workspaceId: 'ws', teamId: 'team-1' }); const opened = await team.open()
 await team.commit('team-1', { expectedRevision: opened.revision, mutate: state => {
  state.leadMemberId = 'lead'
  for (const [memberId, role] of [['lead', 'lead'], ['worker', 'builder'], ['reviewer', 'reviewer']]) state.members.push({ memberId: memberId!, displayName: memberId!, role: role!, availability: 'available', sessionId: `s-${memberId}`, bindingGeneration: 1, contractRevision: 0 })
 } })
 const deliverLifecycleNotice = vi.fn(async (request: LifecycleNoticeRequest): Promise<SubmissionNotificationReceipt> => ({ recipient: request.recipient, purpose: request.intent.kind, state: 'queued', messageId: 'notice1', requestId: 'native1' }))
 const deliverEscalation = vi.fn(async () => { throw new Error('legacy nonfatal notification failure') })
 const options = { workspacePath, teamId: 'team-1', deliverLifecycleNotice, deliverEscalation, interruptSession: async () => undefined, awaitQuiescence: async () => true }
 const store = createTaskStore(options)
 const created = await store.createTask({ title: 'Bounded work', kind: 'work', assignee: 'worker', route: review ? { type: 'review', reviewer: 'reviewer' } : { type: 'report', to: 'lead' }, acceptance: ['Evidence'], actor: 'lead' })
 const taskId = created.task.id
 await store.claimTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 }); await store.acknowledgeTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
 await writeFile(join(workspacePath, 'report.md'), '# Synthetic evidence')
 const submitted = await store.submitTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Done', checks: [] })
 const cleanup = async () => { const p = await realpath(workspacePath); if (!p.startsWith(join(await realpath(tmpdir()), 'live-teams-lifecycle-'))) throw new Error('unsafe fixture cleanup'); await rm(p, { recursive: true, force: true }) }
 return { store, options, taskId, team, submitted, deliverLifecycleNotice, deliverEscalation, cleanup }
}

describe('durable lifecycle boundaries', () => {
 it.each(['lead-change', 'lead-binding-change'] as const)('does not deliver a stale PASS capability after %s', async scenario => {
  const f = await fixture()
  try {
   f.deliverLifecycleNotice.mockImplementationOnce(async request => {
    const current = await f.team.open(); await f.team.commit('team-1', { expectedRevision: current.revision, mutate: draft => {
     if (scenario === 'lead-change') draft.leadMemberId = 'reviewer'
     else { const lead = draft.members.find(member => member.memberId === 'lead')!; lead.sessionId = 's-lead-new'; lead.bindingGeneration++ }
    } })
    expect(await request.stillCurrent()).toBe(false)
    return { recipient: request.recipient, purpose: request.intent.kind, state: 'superseded' }
   })
   const result = await f.store.reviewTask({ taskId: f.taskId, submissionId: f.submitted.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', findings: [], evidence: [{ command: 'inspection-only', status: 'passed' }] })
   expect(result.notifications?.[0]?.state).toBe('superseded')
   await f.store.recoverLifecycleNotifications()
   expect(f.deliverLifecycleNotice.mock.calls.at(-1)?.[0]).toMatchObject(scenario === 'lead-change' ? { recipient: 'reviewer', sessionId: 's-reviewer' } : { recipient: 'lead', sessionId: 's-lead-new', bindingGeneration: 2 })
  } finally { await f.cleanup() }
 })
 it.each(['new-submission', 'revoke'] as const)('fences a delayed manual direction after %s outside task locks', async scenario => {
  const f = await fixture(false)
  try {
   f.deliverLifecycleNotice.mockImplementationOnce(async request => {
    if (scenario === 'revoke') await f.store.revokeTask({ taskId: f.taskId, actor: 'lead', reason: 'Stop obsolete work' })
    else await f.store.submitTask({ taskId: f.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Newer submission', checks: [] })
    expect(await request.stillCurrent()).toBe(false)
    return { recipient: request.recipient, purpose: request.intent.kind, state: 'superseded' }
   })
   expect(await f.store.reviseTask({ taskId: f.taskId, actor: 'lead', instructions: 'Correct existing scope' })).toMatchObject({ notifications: [{ state: 'superseded', purpose: 'direction' }] })
  } finally { await f.cleanup() }
 }, 2000)
 it.each(['pass', 'escalate', 'acceptance', 'cancellation', 'direction'] as const)('publishes an honest receipt for %s without altering decision authority', async scenario => {
  const f = await fixture(scenario === 'pass' || scenario === 'escalate')
  try {
   let result: unknown
   if (scenario === 'pass' || scenario === 'escalate') result = await f.store.reviewTask({ taskId: f.taskId, submissionId: f.submitted.submission.id, reviewerMemberId: 'reviewer', verdict: scenario, findings: scenario === 'escalate' ? [{ severity: 'medium', problem: 'Human decision', requiredFix: 'Ask Lead' }] : [], evidence: [{ command: 'DO_NOT_EXECUTE', status: 'passed' }] })
   else if (scenario === 'acceptance') result = await f.store.acceptTask({ taskId: f.taskId, actor: 'lead' })
   else if (scenario === 'cancellation') result = await f.store.cancelTask({ taskId: f.taskId, actor: 'lead', reason: 'Superseded' })
   else result = await f.store.reviseTask({ taskId: f.taskId, actor: 'lead', instructions: 'Correct only this contract' })
   expect(f.deliverLifecycleNotice).toHaveBeenCalledOnce()
   expect(result).toMatchObject({ notifications: [{ state: 'queued', recipient: scenario === 'pass' || scenario === 'escalate' ? 'lead' : 'worker', purpose: scenario === 'pass' || scenario === 'escalate' ? 'review-verdict' : scenario }] })
   expect(f.deliverEscalation).not.toHaveBeenCalled()
   expect((await f.store.readTask(f.taskId)).task.status).toBe(scenario === 'pass' || scenario === 'acceptance' ? 'completed' : scenario === 'cancellation' ? 'cancelled' : scenario === 'direction' ? 'in_progress' : 'waiting')
  } finally { await f.cleanup() }
 })
 it('never turns a notification failure into a refusal of a saved PASS verdict', async () => {
  const f = await fixture(); f.deliverLifecycleNotice.mockRejectedValue(new Error('private synthetic transport diagnostic'))
  try {
   const result = await f.store.reviewTask({ taskId: f.taskId, submissionId: f.submitted.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', findings: [], evidence: [{ command: 'inspection-only', status: 'passed' }] })
   expect(result).toMatchObject({ notifications: [{ state: 'failed', recipient: 'lead' }] })
   const read = await f.store.readTask(f.taskId); expect(read.rounds).toHaveLength(1); expect(read.task.status).toBe('completed'); expect(JSON.stringify(result)).not.toContain('private synthetic transport diagnostic')
  } finally { await f.cleanup() }
 })
})
