import { mkdtemp, realpath, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamStore } from './team-store.js'
import { createTaskStore } from './task-store.js'
import { createMailbox, type MailboxService } from './mailbox.js'
import { createCommandQueue } from './command-queue.js'
import { createLifecycleNoticePort, lifecycleNoticeDeliveryAllowed } from './lifecycle-notice.js'

describe('real lifecycle outbox recovery', () => {
 for (const scenario of ['pass', 'escalate', 'acceptance', 'cancellation', 'direction'] as const) {
  it.each(['ordinary', 'before-outbox', 'after-native', 'late-binding'])(`${scenario}: %s preserves one action and one native request`, async phase => {
   const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-lifecycle-composition-'))
   try {
    const team = new TeamStore({ workspacePath, workspaceId: 'ws', teamId: 'team-1' }); const opened = await team.open()
    await team.commit('team-1', { expectedRevision: opened.revision, mutate: draft => {
     draft.leadMemberId = 'lead'
     for (const [memberId, role] of [['lead', 'lead'], ['worker', 'builder'], ['reviewer', 'reviewer']]) draft.members.push({ memberId: memberId!, role: role!, displayName: memberId!, availability: 'available', sessionId: `s-${memberId}`, bindingGeneration: 1, contractRevision: 0 })
    } })
    let mailbox: MailboxService; let failBefore = phase === 'before-outbox'; let failAfter = phase === 'after-native'
    const port = createLifecycleNoticePort({ teamId: 'team-1', mailbox: () => mailbox })
    const deliverLifecycleNotice: typeof port = async request => { if (failBefore) { failBefore = false; throw new Error('before outbox') }; const receipt = await port(request); if (failAfter) { failAfter = false; throw new Error('after native acceptance') }; return receipt }
    const options = { workspacePath, teamId: 'team-1', deliverLifecycleNotice, interruptSession: async () => undefined, awaitQuiescence: async () => true }
    const store = createTaskStore(options); const admissions: Array<{ requestId: string; sessionId: string }> = []
    const queue = createCommandQueue({ workspacePath, teamId: 'team-1', deliver: async record => {
     const message = await mailbox.getMessage(record.causationId!)
     if (message === undefined || !await lifecycleNoticeDeliveryAllowed(store, message, record.sessionId, record.bindingGeneration)) throw new Error('obsolete native capability')
     admissions.push({ requestId: record.requestId, sessionId: record.sessionId })
    } })
    mailbox = createMailbox({ workspacePath, teamId: 'team-1', queue, listRecipients: async () => (await team.open()).members, canDeliver: async (message, member) => lifecycleNoticeDeliveryAllowed(store, message, member.sessionId, member.bindingGeneration) })
    const review = scenario === 'pass' || scenario === 'escalate'
    const created = await store.createTask({ title: 'Existing bounded work', kind: 'work', assignee: 'worker', route: review ? { type: 'review', reviewer: 'reviewer' } : { type: 'report', to: 'lead' }, acceptance: ['Frozen scope'], actor: 'lead' }); const taskId = created.task.id
    const claimed = await store.claimTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 }); await store.acknowledgeTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
    await writeFile(join(workspacePath, 'report.md'), '# Evidence')
    const submitted = await store.submitTask({ taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Done', checks: [{ command: 'touch must-not-execute', status: 'passed' }] })
    const target = review ? 'lead' : 'worker'
    if (phase === 'late-binding') { const current = await team.open(); await team.commit('team-1', { expectedRevision: current.revision, mutate: draft => { delete draft.members.find(member => member.memberId === target)!.sessionId } }) }
    let result: { notifications?: Array<{ state: string }> }
    if (scenario === 'pass' || scenario === 'escalate') result = await store.reviewTask({ taskId, submissionId: submitted.submission.id, reviewerMemberId: 'reviewer', verdict: scenario, findings: scenario === 'escalate' ? [{ severity: 'medium', problem: 'Needs decision', requiredFix: 'Ask Lead' }] : [], evidence: [{ command: 'synthetic-inspection-only', status: 'passed' }] })
    else if (scenario === 'acceptance') result = await store.acceptTask({ taskId, actor: 'lead' })
    else if (scenario === 'cancellation') result = await store.cancelTask({ taskId, actor: 'lead', reason: 'Stopped by approved policy' })
    else result = await store.reviseTask({ taskId, actor: 'lead', instructions: 'Correct within the existing contract' })
    expect(result.notifications?.[0]?.state).toBe(phase === 'late-binding' ? 'unavailable' : phase === 'ordinary' ? 'queued' : 'failed')
    if (phase === 'late-binding') { const current = await team.open(); await team.commit('team-1', { expectedRevision: current.revision, mutate: draft => { draft.members.find(member => member.memberId === target)!.sessionId = `s-${target}` } }) }
    const reopened = createTaskStore(options)
    await Promise.all([store.recoverLifecycleNotifications(), reopened.recoverLifecycleNotifications()]); await reopened.recoverLifecycleNotifications()
    expect(admissions).toHaveLength(1); expect(admissions[0]?.sessionId).toBe(`s-${target}`)
    const read = await store.readTask(taskId)
    expect(read.submissions).toHaveLength(1); expect(read.task.route).toEqual(created.task.route)
    expect(read.rounds).toHaveLength(review ? 1 : 0)
    if (scenario !== 'cancellation') expect(read.task.activeAttemptId).toBe(claimed.attempt.id)
    await expect(stat(join(workspacePath, 'must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (scenario === 'pass') {
     const before = JSON.stringify(read.rounds)
     await expect(store.requestReviewNotification(taskId, read.rounds[0]!.id, 'worker')).rejects.toThrow('only the lead or human')
     await expect(store.requestReviewNotification(taskId, 'wrong-round', 'lead')).rejects.toThrow('no longer matches')
     // Simulate a legacy row with no prospective marker. Stable round identity must reuse existing outbox.
     const file = join(store.directoryPath, 'tasks.json'); const raw = JSON.parse(await readFile(file, 'utf8')) as { tasks: Array<{ lifecycleNotices?: unknown }> }; for (const task of raw.tasks) delete task.lifecycleNotices; await writeFile(file, JSON.stringify(raw))
     await store.recoverLifecycleNotifications(); expect(admissions).toHaveLength(1)
     expect(await store.requestReviewNotification(taskId, read.rounds[0]!.id, 'human:desktop')).toMatchObject([{ state: 'queued', recipient: 'lead' }])
     expect(admissions).toHaveLength(1); expect(JSON.stringify((await store.readTask(taskId)).rounds)).toBe(before)
    }
   } finally { const path = await realpath(workspacePath); if (!path.startsWith(join(await realpath(tmpdir()), 'live-teams-lifecycle-composition-'))) throw new Error('unsafe fixture cleanup'); await rm(path, { recursive: true, force: true }) }
  })
 }
})
