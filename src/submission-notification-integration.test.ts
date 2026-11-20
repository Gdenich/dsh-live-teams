import { mkdtemp, realpath, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamStore } from './team-store.js'
import { createTaskStore } from './task-store.js'
import { createMailbox, type MailboxService } from './mailbox.js'
import { createCommandQueue } from './command-queue.js'
import { createSubmissionNoticePort, submissionNoticeDeliveryAllowed } from './submission-notice-ports.js'

describe('durable submission notification composition', () => {
 it.each((['report', 'review'] as const).flatMap(routeType => [false, true].flatMap(acknowledge => ['ordinary', 'before-outbox', 'after-admission', 'binding-late', 'stale-before-native', 'lead-changed', 'recipient-rebound', 'disabled-before-native'].map(scenario => ({ routeType, acknowledge, scenario })))))('recovers one current capability without project execution: $routeType ack=$acknowledge $scenario', async ({ routeType, acknowledge, scenario }) => {
   const recipientId = routeType === 'review' ? 'reviewer' : 'lead'
  const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-submission-composition-'))
  try {
   const team = new TeamStore({ workspacePath, workspaceId: 'ws', teamId: 'team-1' }); const opened = await team.open()
   await team.commit('team-1', { expectedRevision: opened.revision, mutate: draft => {
    draft.leadMemberId = 'lead'
    for (const [memberId, role] of [['lead', 'lead'], ['worker', 'builder'], ['reviewer', 'reviewer']]) draft.members.push({ memberId: memberId!, role: role!, displayName: memberId!, availability: 'available', ...(memberId === recipientId && scenario === 'binding-late' ? {} : { sessionId: `s-${memberId}` }), bindingGeneration: 1, contractRevision: 0 })
   } })
   let mailbox: MailboxService
   let taskId = ''; let failOnce = scenario === 'before-outbox'; let invalidate = scenario === 'stale-before-native'; let rebound = scenario === 'recipient-rebound'; let disable = scenario === 'disabled-before-native'; let loseResponse = scenario === 'after-admission'
   const basePort = createSubmissionNoticePort({ teamId: 'team-1', mailbox: () => mailbox })
   const deliverSubmissionNotice: typeof basePort = async request => { if (failOnce) { failOnce = false; throw new Error('before outbox persistence') }; const result = await basePort(request); if (loseResponse) { loseResponse = false; throw new Error('response lost after admission') }; return result }
   const options = { workspacePath, teamId: 'team-1', deliverSubmissionNotice }
   const store = createTaskStore(options)
   const admissions: Array<{ sessionId: string; requestId: string }> = []
   const queue = createCommandQueue({ workspacePath, teamId: 'team-1', deliver: async record => {
    if (invalidate) { invalidate = false; await store.acceptTask({ taskId, actor: 'lead' }) }
     if (rebound) { rebound = false; const current = await team.open(); await team.commit('team-1', { expectedRevision: current.revision, mutate: draft => { const member = draft.members.find(entry => entry.memberId === recipientId)!; member.sessionId = `s-${recipientId}-new`; member.bindingGeneration += 1 } }) }
     if (disable) { disable = false; await writeFile(join(workspacePath, '.dsh-live-teams', 'teams', 'team-1', 'disabled'), '') }
    const message = await mailbox.getMessage(record.causationId!)
    if (message === undefined || !await submissionNoticeDeliveryAllowed(store, message, record.sessionId, record.bindingGeneration)) throw new Error('stale native notification')
    admissions.push({ sessionId: record.sessionId, requestId: record.requestId })
   } })
   mailbox = createMailbox({ workspacePath, teamId: 'team-1', queue, listRecipients: async () => (await team.open()).members.map(member => ({ memberId: member.memberId, ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }), bindingGeneration: member.bindingGeneration })), canDeliver: async (message, member) => submissionNoticeDeliveryAllowed(store, message, member.sessionId, member.bindingGeneration) })
   const route = routeType === 'review' ? { type: 'review' as const, reviewer: 'reviewer' } : { type: 'report' as const, to: 'human' }
    const created = await store.createTask({ title: 'Existing submission contract', kind: 'work', assignee: 'worker', route, acceptance: ['Evidence only'], actor: 'lead' }); taskId = created.task.id
   const claimed = await store.claimTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 }); if (acknowledge) await store.acknowledgeTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
   await writeFile(join(workspacePath, 'report.md'), '# Formal report')
   const submitted = await store.submitTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Ready', checks: [{ command: 'touch must-not-execute', status: 'passed' }] })
   if (scenario === 'before-outbox' || scenario === 'after-admission') expect(submitted.notifications[0]?.state).toBe('failed')
   if (scenario === 'binding-late') {
    expect(submitted.notifications[0]?.state).toBe('unavailable')
    const current = await team.open(); await team.commit('team-1', { expectedRevision: current.revision, mutate: draft => { draft.members.find(member => member.memberId === recipientId)!.sessionId = `s-${recipientId}` } })
   }
   if (scenario === 'lead-changed') {
    const current = await team.open(); await team.commit('team-1', { expectedRevision: current.revision, mutate: draft => { draft.leadMemberId = 'reviewer' } })
   }
   const reopened = createTaskStore(options)
   await Promise.all([store.recoverSubmissionNotifications(), reopened.recoverSubmissionNotifications()]); await reopened.recoverSubmissionNotifications()
   if (scenario === 'stale-before-native' || scenario === 'disabled-before-native') {
    expect(submitted.notifications[0]?.state).toBe('superseded'); expect(admissions).toHaveLength(0)
   } else {
    expect(admissions).toHaveLength(scenario === 'lead-changed' && routeType === 'report' ? 2 : 1)
    expect(new Set(admissions.map(item => item.requestId)).size).toBe(admissions.length)
    expect(admissions.at(-1)?.sessionId).toBe(scenario === 'recipient-rebound' ? `s-${recipientId}-new` : scenario === 'lead-changed' && routeType === 'report' ? 's-reviewer' : `s-${recipientId}`)
    const latest = (await store.readTask(taskId)).task
    expect(latest.contractRevision).toBe(created.task.contractRevision); expect(latest.activeAttemptId).toBe(claimed.attempt.id); expect(latest.route).toEqual(route)
    expect(latest.status).toBe(routeType === 'report' ? 'waiting' : acknowledge ? 'in_progress' : 'claimed')
   }
   expect((await store.readTask(taskId)).submissions).toHaveLength(1)
   await expect(stat(join(workspacePath, 'must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
   const path = await realpath(workspacePath); if (!path.startsWith(join(await realpath(tmpdir()), 'live-teams-submission-composition-'))) throw new Error('unsafe fixture cleanup'); await rm(path, { recursive: true, force: true })
  }
 })
})
