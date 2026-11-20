import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TeamStore } from './team-store.js'
import { createTaskStore } from './task-store.js'
import type { SessionExecutionReceipt } from './session-bridge.js'

async function fixture(roundLimit = 5) {
  const workspace = await mkdtemp(join(tmpdir(), 'live-teams-review-return-'))
  const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
  const opened = await team.open()
  await team.commit('team-1', { expectedRevision: opened.revision, mutate: state => {
    state.leadMemberId = 'lead'
    for (const [memberId, role] of [['lead', 'lead'], ['worker', 'builder'], ['reviewer', 'reviewer']]) {
      state.members.push({ memberId: memberId!, displayName: memberId!, role: role!, availability: 'available', sessionId: `s-${memberId}`, bindingGeneration: 1, contractRevision: 0 })
    }
  } })
  const audit: unknown[] = []
  const deliverReviewReturn = vi.fn(async (_request: unknown): Promise<{ messageId: string; requestId: string; pending?: boolean }> => ({ messageId: 'return-message', requestId: 'return-request' }))
  const observeReviewReturn = vi.fn(async (_request: unknown): Promise<SessionExecutionReceipt> => ({ state: 'started', turn: 7, inputSeq: 10 }))
  const notifyReviewReturn = vi.fn(async (_request: unknown) => undefined)
  // A variable intentionally permits the future ports to be supplied to the old store
  // so the behavioral regression can fail before the implementation exists.
  const options = { workspacePath: workspace, teamId: 'team-1', interruptSession: async () => undefined, awaitQuiescence: async () => true, appendAudit: async (event: unknown) => { audit.push(event) }, deliverReviewReturn, observeReviewReturn, notifyReviewReturn }
  const store = createTaskStore(options)
  const created = await store.createTask({ title: 'Ordinary correction', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['Existing contract'], paths: ['report.md'], actor: 'lead', roundLimit })
  const claimed = await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
  await store.acknowledgeTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
  await writeFile(join(workspace, 'report.md'), '# Original submission\n')
  const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Please review', checks: [] })
  const review = () => store.reviewTask({ taskId: created.task.id, submissionId: submitted.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision', findings: [{ severity: 'medium', problem: 'Missing boundary case', requiredFix: 'Correct only the existing contract\nKeep Unicode: исправить.' }], evidence: [{ command: 'declared-only-do-not-execute', status: 'failed' }] })
  const cleanup = async () => {
    const resolved = await realpath(workspace)
    const root = await realpath(tmpdir())
    if (!resolved.startsWith(join(root, 'live-teams-review-return-'))) throw new Error('unexpected fixture cleanup path')
    await rm(resolved, { recursive: true, force: true })
  }
  return { workspace, taskFile: join(workspace, '.dsh-live-teams', 'teams', 'team-1', 'tasks.json'), team, store, created, claimed, submitted, review, audit, deliverReviewReturn, observeReviewReturn, notifyReviewReturn, cleanup }
}

describe('automatic NEEDS_REVISION return', () => {
  it('never wakes Lead with an old return problem after the task is terminal', async () => {
    const f = await fixture()
    try {
      const result = await f.review()
      const raw = JSON.parse(await readFile(f.taskFile, 'utf8')) as { tasks: Array<{ id: string; status: string; reviewReturn?: { leadNotified?: boolean } }> }
      const task = raw.tasks.find(entry => entry.id === f.created.task.id)!
      task.status = 'completed'; task.reviewReturn!.leadNotified = false
      await writeFile(f.taskFile, JSON.stringify(raw))
      expect(await f.store.isReviewReturnLeadCurrent(task.id, result.round.id, 'lead', 'returned', 's-lead', 1)).toBe(false)
      const before = f.notifyReviewReturn.mock.calls.length
      await f.store.recoverReviewReturns()
      expect(f.notifyReviewReturn).toHaveBeenCalledTimes(before)
    } finally { await f.cleanup() }
  })
  it('marks the old launch metadata superseded when a corrected submission arrives', async () => {
    const f = await fixture()
    try {
      await f.review()
      await writeFile(join(f.workspace, 'report.md'), '# Corrected')
      await f.store.submitTask({ taskId: f.created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Corrected', checks: [] })
      expect((await f.store.readTask(f.created.task.id)).task.reviewReturn).toMatchObject({ state: 'superseded', reason: 'new-submission' })
    } finally { await f.cleanup() }
  })
  it('preserves the reviewer round limit and never wakes the author for an excess return', async () => {
    const f = await fixture(1)
    try {
      await f.review()
      await writeFile(join(f.workspace, 'report.md'), '# Second submission')
      const second = await f.store.submitTask({ taskId: f.created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Second', checks: [] })
      await expect(f.store.reviewTask({ taskId: f.created.task.id, submissionId: second.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision', findings: [{ severity: 'high', problem: 'Still wrong', requiredFix: 'Escalate' }] })).rejects.toThrow('round limit 1 reached')
      expect(f.deliverReviewReturn).toHaveBeenCalledOnce()
      expect((await f.store.readTask(f.created.task.id)).rounds).toHaveLength(1)
    } finally { await f.cleanup() }
  })
  it('retains a fresh-runtime intervention block across a late delivery result and notifies the lead accurately', async () => {
    const f = await fixture()
    try {
      f.deliverReviewReturn.mockImplementation(async (value) => {
        const request = value as { intent: import('./task-store.js').ReviewReturn }
        await f.store.blockReviewReturn(f.created.task.id, request.intent, 'human-intervened')
        return { messageId: 'return-message', requestId: 'return-request' }
      })
      const result = await f.review()
      expect(result.task.status).toBe('waiting')
      expect(result.task.reviewReturn).toMatchObject({ state: 'blocked', reason: 'human-intervened', leadNotified: true })
      expect(f.observeReviewReturn).not.toHaveBeenCalled()
      expect(f.notifyReviewReturn).toHaveBeenCalledWith(expect.objectContaining({ intent: expect.objectContaining({ state: 'blocked' }) }))
    } finally { await f.cleanup() }
  })
  it('makes a known launch failure manually revisable and fences the old automatic return', async () => {
    const f = await fixture()
    try {
      f.deliverReviewReturn.mockRejectedValue(new Error('failed'))
      expect((await f.review()).task.status).toBe('needs_human')
      const revised = await f.store.reviseTask({ taskId: f.created.task.id, actor: 'lead', instructions: 'Environment fixed; continue explicitly.' })
      expect(revised.task.status).toBe('in_progress')
      expect(revised.task.reviewReturn?.state).toBe('superseded')
      await f.store.processReviewReturn(f.created.task.id)
      expect(f.deliverReviewReturn).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it('does not overwrite a fresh submission made during the external handoff', async () => {
    const f = await fixture()
    try {
      let latest: string | undefined
      f.deliverReviewReturn.mockImplementation(async () => {
        await writeFile(join(f.workspace, 'report.md'), '# Corrected submission\n')
        latest = (await f.store.submitTask({ taskId: f.created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Fixed', checks: [] })).submission.id
        return { messageId: 'return-message', requestId: 'return-request' }
      })
      const result = await f.review()
      expect(result.task.latestSubmissionId).toBe(latest)
      expect(result.task.awaitsDecision).toBe(true)
      expect(result.task.reviewReturn?.state).toBe('superseded')
      expect(f.observeReviewReturn).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it('does not persist a claimed start without an exact turn/input receipt', async () => {
    const f = await fixture()
    try {
      f.observeReviewReturn.mockResolvedValue({ state: 'started' })
      expect((await f.review()).task.reviewReturn).toMatchObject({ state: 'unconfirmed', reason: 'invalid-execution-receipt' })
      expect((await f.store.readTask(f.created.task.id)).task.reviewReturn?.state).toBe('unconfirmed')
    } finally { await f.cleanup() }
  })
  it('recovers an explicit pending delivery after reopening, without inventing a new attempt', async () => {
    const f = await fixture()
    try {
      f.deliverReviewReturn.mockResolvedValueOnce({ messageId: 'return-message', requestId: 'return-request', pending: true })
      f.observeReviewReturn.mockResolvedValueOnce({ state: 'pending' })
      expect((await f.review()).task.reviewReturn).toMatchObject({ state: 'sending', reason: 'delivery-pending' })
      const reopened = createTaskStore({ workspacePath: f.workspace, teamId: 'team-1', deliverReviewReturn: f.deliverReviewReturn, observeReviewReturn: f.observeReviewReturn, notifyReviewReturn: f.notifyReviewReturn })
      await reopened.recoverReviewReturns()
      expect((await reopened.readTask(f.created.task.id)).task.reviewReturn).toMatchObject({ state: 'started', requestId: 'return-request' })
      expect((await reopened.readAttempts()).attempts).toHaveLength(1)
    } finally { await f.cleanup() }
  })
  it('allows handoff and observer callbacks to read the store without deadlocking', async () => {
    const f = await fixture()
    try {
      f.deliverReviewReturn.mockImplementation(async () => { await f.store.readTask(f.created.task.id); return { messageId: 'return-message', requestId: 'return-request' } })
      f.observeReviewReturn.mockImplementation(async () => { await f.store.readAttempts(); return { state: 'started', turn: 7, inputSeq: 10 } })
      f.notifyReviewReturn.mockImplementation(async () => { await f.store.readTask(f.created.task.id) })
      expect((await f.review()).task.reviewReturn?.state).toBe('started')
    } finally { await f.cleanup() }
  }, 2000)

  it('does not resend an accepted request when observation is initially pending', async () => {
    const f = await fixture()
    try {
      f.observeReviewReturn.mockResolvedValueOnce({ state: 'pending' })
      expect((await f.review()).task.reviewReturn?.state).toBe('unconfirmed')
      expect(f.notifyReviewReturn).not.toHaveBeenCalled()
      await f.store.processReviewReturn(f.created.task.id)
      expect((await f.store.readTask(f.created.task.id)).task.reviewReturn).toMatchObject({ state: 'started' })
      expect((await f.store.readTask(f.created.task.id)).task.reviewReturn?.reason).toBeUndefined()
      expect(f.deliverReviewReturn).toHaveBeenCalledOnce()
      expect(f.notifyReviewReturn).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })

  it('reports failed delivery to the lead without claiming execution', async () => {
    const f = await fixture()
    try {
      f.deliverReviewReturn.mockRejectedValue(new Error('private transport detail'))
      expect((await f.review()).task.reviewReturn).toMatchObject({ state: 'failed', reason: 'delivery-failed' })
      expect(f.observeReviewReturn).not.toHaveBeenCalled()
      expect(f.notifyReviewReturn).toHaveBeenCalledOnce()
      expect(JSON.stringify(f.audit)).not.toContain('private transport detail')
    } finally { await f.cleanup() }
  })

  it('does not reopen a task cancelled during the external send', async () => {
    const f = await fixture()
    try {
      f.deliverReviewReturn.mockImplementation(async () => {
        await f.store.cancelTask({ taskId: f.created.task.id, actor: 'lead', reason: 'Stop this fixture' })
        return { messageId: 'return-message', requestId: 'return-request' }
      })
      const result = await f.review()
      expect(result.task.status).toBe('cancelled')
      expect(result.task.reviewReturn?.state).toBe('superseded')
      expect(f.observeReviewReturn).not.toHaveBeenCalled()
      expect((await f.store.readAttempts()).attempts[0]?.status).not.toBe('active')
    } finally { await f.cleanup() }
  })

  it('keeps pending Git evidence and blocks automatic correction', async () => {
    const f = await fixture()
    try {
      const tasks = JSON.parse(await readFile(f.taskFile, 'utf8'))
      const marker = { baseRef: 'refs/heads/main', headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40), at: Date.now() }
      tasks.tasks[0].integrationPending = marker
      await writeFile(f.taskFile, JSON.stringify(tasks))
      const result = await f.review()
      expect(result.task.integrationPending).toEqual(marker)
      expect(result.task.reviewReturn).toMatchObject({ state: 'blocked', reason: 'integration-pending' })
      expect(f.deliverReviewReturn).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  it('does not invent return intents for historical reviews', async () => {
    const f = await fixture()
    try {
      await f.review()
      const tasks = JSON.parse(await readFile(f.taskFile, 'utf8'))
      delete tasks.tasks[0].reviewReturn
      await writeFile(f.taskFile, JSON.stringify(tasks))
      f.deliverReviewReturn.mockClear(); f.notifyReviewReturn.mockClear()
      await f.store.processReviewReturn(f.created.task.id)
      expect(f.deliverReviewReturn).not.toHaveBeenCalled()
      expect(f.notifyReviewReturn).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it('continues the current attempt without changing the accepted contract and confirms execution separately', async () => {
    const f = await fixture()
    try {
      const before = (await f.store.readTask(f.created.task.id)).task
      const result = await f.review()
      expect(result.task.status).toBe('in_progress')
      expect(result.task.activeAttemptId).toBe(f.claimed.attempt.id)
      for (const key of ['assignee', 'route', 'acceptance', 'paths', 'kind', 'roundLimit', 'contractRevision'] as const) expect(result.task[key]).toEqual(before[key])
      expect((await f.store.readAttempts()).attempts).toHaveLength(1)
      expect((await f.store.readAttempts()).attempts[0]).toMatchObject({ id: f.claimed.attempt.id, generation: 1, status: 'active' })
      expect(f.deliverReviewReturn).toHaveBeenCalledOnce()
      expect(f.observeReviewReturn).toHaveBeenCalledOnce()
      expect(f.notifyReviewReturn).toHaveBeenCalledOnce()
      expect(result.task).toMatchObject({ reviewReturn: { roundId: result.round.id, state: 'started', requestId: 'return-request' } })
      expect(await readFile(join(f.workspace, 'report.md'), 'utf8')).toBe('# Original submission\n')
    } finally { await f.cleanup() }
  })

  it.each(['human-intervened', 'dispatch-paused', 'member-unavailable', 'binding-changed'])('records the verdict but does not wake the author when %s', async reason => {
    const f = await fixture()
    try {
      if (reason === 'human-intervened') await f.store.markHumanIntervention(f.claimed.attempt.id, Date.now())
      else {
        const state = await f.team.open()
        await f.team.commit('team-1', { expectedRevision: state.revision, mutate: next => {
          if (reason === 'dispatch-paused') next.dispatch = { mode: 'paused', by: 'human', at: Date.now() }
          if (reason === 'member-unavailable') next.members.find(member => member.memberId === 'worker')!.availability = 'paused'
          if (reason === 'binding-changed') next.members.find(member => member.memberId === 'worker')!.bindingGeneration = 2
        } })
      }
      const result = await f.review()
      expect(result.task.status).toBe('waiting')
      expect(result.task).toMatchObject({ reviewReturn: { state: 'blocked', reason } })
      expect(f.deliverReviewReturn).not.toHaveBeenCalled()
      expect(f.observeReviewReturn).not.toHaveBeenCalled()
      expect(f.notifyReviewReturn).toHaveBeenCalledOnce()
      expect((await f.store.readReviews()).rounds).toHaveLength(1)
    } finally { await f.cleanup() }
  })
})
