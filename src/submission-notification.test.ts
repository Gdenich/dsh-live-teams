import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TeamStore } from './team-store.js'
import { createTaskStore, type TeamTask, type SubmissionNotificationRequest, type SubmissionNotificationReceipt } from './task-store.js'

async function fixture(route: { type: 'report'; to: string } | { type: 'review'; reviewer: string } = { type: 'report', to: 'human' }, acknowledge = true) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'live-teams-submit-notice-'))
  const team = new TeamStore({ workspacePath, workspaceId: 'ws', teamId: 'team-1' }); const opened = await team.open()
  await team.commit('team-1', { expectedRevision: opened.revision, mutate: state => {
    state.leadMemberId = 'lead'
    for (const [memberId, role] of [['lead', 'lead'], ['worker', 'builder'], ['reviewer', 'reviewer']]) state.members.push({ memberId: memberId!, displayName: memberId!, role: role!, availability: 'available', sessionId: `s-${memberId}`, bindingGeneration: 1, contractRevision: 0 })
  } })
  const deliverSubmissionNotice = vi.fn(async (request: SubmissionNotificationRequest): Promise<SubmissionNotificationReceipt> => ({ recipient: request.recipient, purpose: request.purpose, state: 'queued', messageId: 'notice1', requestId: 'request1' }))
  const options = { workspacePath, teamId: 'team-1', deliverSubmissionNotice }
  const store = createTaskStore(options)
  const created = await store.createTask({ title: 'Small work', kind: 'work', assignee: 'worker', route, acceptance: ['Done'], actor: 'lead' })
  await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
  if (acknowledge) await store.acknowledgeTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
  await writeFile(join(workspacePath, 'report.md'), '# Evidence')
  const submit = () => store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report' as const, bodyRef: 'report.md' }, summary: 'Ready for decision', checks: [{ command: 'DO_NOT_EXECUTE_PROJECT_CHECK', status: 'passed' as const }] })
  const cleanup = async () => { const path = await realpath(workspacePath); if (!path.startsWith(join(await realpath(tmpdir()), 'live-teams-submit-notice-'))) throw new Error('unsafe fixture path'); await rm(path, { recursive: true, force: true }) }
  return { store, options, created, team, deliverSubmissionNotice, submit, cleanup, taskFile: join(workspacePath, '.dsh-live-teams', 'teams', 'team-1', 'tasks.json') }
}

describe('truthful submission handoff receipts', () => {
  it('invalidates a previous claimed-review capability when a newer submission replaces it', async () => {
    const f = await fixture({ type: 'review', reviewer: 'reviewer' }, false)
    try {
      const first = await f.submit()
      const previous = f.deliverSubmissionNotice.mock.calls[0]![0]
      await writeFile(join(f.options.workspacePath, 'report.md'), '# Updated synthetic evidence')
      const second = await f.submit()
      expect(second.submission.id).not.toBe(first.submission.id)
      expect(await previous.stillCurrent()).toBe(false)
      expect(await f.store.isSubmissionNotificationCurrent(f.created.task.id, second.submission.id, 'reviewer', 'review', 's-reviewer', 1)).toBe(true)
      await expect(f.store.requestSubmissionNotification(f.created.task.id, first.submission.id, 'lead')).rejects.toThrow('no longer awaits')
      expect((await f.store.readTask(f.created.task.id)).task.status).toBe('claimed')
    } finally { await f.cleanup() }
  })
  it.each([
    { awaitsDecision: false }, { archivedPath: 'archive/closed.md' }, { status: 'completed' },
    { status: 'cancelled' }, { status: 'failed' }, { status: 'needs_human' }, { status: 'draft' },
  ] satisfies Partial<TeamTask>[])('keeps stale/terminal claimed-review capabilities fenced after $status $latestSubmissionId $archivedPath $awaitsDecision', async patch => {
    const f = await fixture({ type: 'review', reviewer: 'reviewer' }, false)
    try {
      const result = await f.submit()
      const capability = f.deliverSubmissionNotice.mock.calls[0]![0]
      const saved = JSON.parse(await readFile(f.taskFile, 'utf8')) as { tasks: TeamTask[] }
      Object.assign(saved.tasks[0]!, patch)
      await writeFile(f.taskFile, JSON.stringify(saved))
      f.deliverSubmissionNotice.mockClear()
      expect(await capability.stillCurrent()).toBe(false)
      await f.store.recoverSubmissionNotifications()
      expect(f.deliverSubmissionNotice).not.toHaveBeenCalled()
      await expect(f.store.requestSubmissionNotification(f.created.task.id, result.submission.id, 'lead')).rejects.toThrow('no longer awaits')
    } finally { await f.cleanup() }
  })
  it.each([
    { kind: 'review', acknowledge: false }, { kind: 'review', acknowledge: true },
    { kind: 'report', acknowledge: false }, { kind: 'report', acknowledge: true },
  ] as const)('notifies the existing recipient for $kind after claim (ack=$acknowledge), without rewriting status', async ({ kind, acknowledge }) => {
    const route = kind === 'review' ? { type: 'review' as const, reviewer: 'reviewer' } : { type: 'report' as const, to: 'human' }
    const f = await fixture(route, acknowledge)
    try {
      const before = await f.store.readTask(f.created.task.id)
      const result = await f.submit()
      const current = await f.store.readTask(f.created.task.id)
      const recipient = kind === 'review' ? 'reviewer' : 'lead'
      const purpose = kind === 'review' ? 'review' : 'lead-acceptance'
      expect(result.notifications).toEqual([{ recipient, purpose, state: 'queued', messageId: 'notice1', requestId: 'request1' }])
      expect(f.deliverSubmissionNotice).toHaveBeenCalledOnce()
      expect(current.task).toMatchObject({ status: kind === 'report' ? 'waiting' : acknowledge ? 'in_progress' : 'claimed', awaitsDecision: true, submissionNoticeId: result.submission.id, route, activeAttemptId: before.task.activeAttemptId, contractRevision: before.task.contractRevision })
      expect(current.submissions).toHaveLength(1)
      expect(await f.store.isSubmissionNotificationCurrent(f.created.task.id, result.submission.id, recipient, purpose, `s-${recipient}`, 1)).toBe(true)
      expect(await f.store.isSubmissionNotificationCurrent(f.created.task.id, result.submission.id, 'wrong-recipient', purpose, `s-${recipient}`, 1)).toBe(false)
    } finally { await f.cleanup() }
  })
  it('recovers a saved claimed review after a pre-outbox failure without acknowledging or resubmitting', async () => {
    const f = await fixture({ type: 'review', reviewer: 'reviewer' }, false)
    try {
      f.deliverSubmissionNotice.mockRejectedValueOnce(new Error('synthetic pre-outbox failure'))
      const submitted = await f.submit()
      expect(submitted.notifications).toMatchObject([{ recipient: 'reviewer', purpose: 'review', state: 'failed' }])
      f.deliverSubmissionNotice.mockClear()
      await createTaskStore(f.options).recoverSubmissionNotifications()
      expect(f.deliverSubmissionNotice).toHaveBeenCalledOnce()
      const current = await f.store.readTask(f.created.task.id)
      expect(current.task).toMatchObject({ status: 'claimed', awaitsDecision: true, latestSubmissionId: submitted.submission.id })
      expect(current.submissions).toHaveLength(1)
    } finally { await f.cleanup() }
  })
  it('repairs only an explicitly authorized claimed submission and never auto-backfills an unmarked one', async () => {
    const f = await fixture({ type: 'review', reviewer: 'reviewer' }, false)
    try {
      const submitted = await f.submit()
      const state = JSON.parse(await readFile(f.taskFile, 'utf8')) as { tasks: Array<{ submissionNoticeId?: string }> }
      for (const task of state.tasks) delete task.submissionNoticeId
      await writeFile(f.taskFile, JSON.stringify(state))
      f.deliverSubmissionNotice.mockClear()
      await f.store.recoverSubmissionNotifications()
      expect(f.deliverSubmissionNotice).not.toHaveBeenCalled()
      await expect(f.store.requestSubmissionNotification(f.created.task.id, submitted.submission.id, 'worker')).rejects.toThrow('only the lead or human')
      await expect(f.store.requestSubmissionNotification(f.created.task.id, 'wrong-submission', 'lead')).rejects.toThrow('no longer awaits')
      expect(await f.store.requestSubmissionNotification(f.created.task.id, submitted.submission.id, 'lead')).toMatchObject([{ recipient: 'reviewer', purpose: 'review', state: 'queued' }])
      expect((await f.store.readTask(f.created.task.id)).task.status).toBe('claimed')
      expect((await f.store.readTask(f.created.task.id)).submissions).toHaveLength(1)
    } finally { await f.cleanup() }
  })
  it('never backfills historical submissions automatically and admits only explicit Lead/human repair', async () => {
    const f = await fixture()
    try {
      const submitted = await f.submit()
      const saved = JSON.parse(await readFile(f.taskFile, 'utf8')) as { tasks: Array<{ submissionNoticeId?: string }> }
      for (const task of saved.tasks) delete task.submissionNoticeId
      await writeFile(f.taskFile, JSON.stringify(saved))
      f.deliverSubmissionNotice.mockClear()
      await f.store.recoverSubmissionNotifications()
      expect(f.deliverSubmissionNotice).not.toHaveBeenCalled()
      await expect(f.store.requestSubmissionNotification(f.created.task.id, submitted.submission.id, 'worker')).rejects.toThrow('only the lead or human')
      await expect(f.store.requestSubmissionNotification(f.created.task.id, 'wrong-submission', 'lead')).rejects.toThrow('no longer awaits')
      expect(await f.store.requestSubmissionNotification(f.created.task.id, submitted.submission.id, 'lead')).toMatchObject([{ recipient: 'lead', state: 'queued' }])
      expect((await f.store.readTask(f.created.task.id)).submissions).toHaveLength(1)
      expect((await f.store.readTask(f.created.task.id)).task.contractRevision).toBe(f.created.task.contractRevision)
      await f.store.acceptTask({ taskId: f.created.task.id, actor: 'lead' })
      await expect(f.store.requestSubmissionNotification(f.created.task.id, submitted.submission.id, 'lead')).rejects.toThrow('no longer awaits')
    } finally { await f.cleanup() }
  })
  it.each(['human', 'reviewer'])('notifies Lead for a report addressed to %s without changing the route', async to => {
    const f = await fixture({ type: 'report', to })
    try {
      const result = await f.submit()
      expect(f.deliverSubmissionNotice).toHaveBeenCalledOnce()
      expect(f.deliverSubmissionNotice.mock.calls[0]![0]).toMatchObject({ recipient: 'lead', purpose: 'lead-acceptance' })
      expect(result).toMatchObject({ notifications: [{ recipient: 'lead', state: 'queued', messageId: 'notice1', requestId: 'request1' }] })
      const task = (await f.store.readTask(f.created.task.id)).task
      expect(task.route).toEqual({ type: 'report', to })
      expect(task).toMatchObject({ status: 'waiting', awaitsDecision: true, submissionNoticeId: result.submission.id })
    } finally { await f.cleanup() }
  })
  it('targets only the designated Reviewer for a review route', async () => {
    const f = await fixture({ type: 'review', reviewer: 'reviewer' })
    try { await f.submit(); expect(f.deliverSubmissionNotice.mock.calls[0]![0]).toMatchObject({ recipient: 'reviewer', purpose: 'review' }); expect(f.deliverSubmissionNotice).toHaveBeenCalledOnce() } finally { await f.cleanup() }
  })
  it('keeps the submission durable and reports notification errors instead of silently claiming delivery', async () => {
    const f = await fixture(); f.deliverSubmissionNotice.mockRejectedValue(new Error('synthetic private failure detail'))
    try {
      const result = await f.submit()
      expect(result).toMatchObject({ notifications: [{ recipient: 'lead', state: 'failed' }] })
      expect((await f.store.readTask(f.created.task.id)).submissions).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain('synthetic private failure detail')
    } finally { await f.cleanup() }
  })
  it('calls the delivery port outside task locks and fences acceptance before a delayed send', async () => {
    const f = await fixture()
    try {
      f.deliverSubmissionNotice.mockImplementation(async request => {
        const current = await f.store.readTask(f.created.task.id)
        await f.store.acceptTask({ taskId: current.task.id, actor: 'lead' })
        expect(await request.stillCurrent()).toBe(false)
        return { recipient: request.recipient, purpose: request.purpose, state: 'superseded', messageId: '', requestId: '' }
      })
      const result = await f.submit()
      expect(result).toMatchObject({ notifications: [{ state: 'superseded' }] })
    } finally { await f.cleanup() }
  }, 2000)
})
