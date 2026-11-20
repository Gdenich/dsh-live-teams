import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamStore, type TeamState } from './team-store.js'
import { createTaskStore, type CreateTaskRequest, type TaskStore } from './task-store.js'

function state(): TeamState {
  return { schemaVersion: 1, revision: 1, teamId: 'team-1', workspaceId: 'workspace-1', workspacePath: '/tmp', members: [
    { memberId: 'lead', displayName: 'Lead', role: 'lead', availability: 'available', sessionId: 's-lead', bindingGeneration: 1, contractRevision: 0 },
    { memberId: 'worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 's-worker', bindingGeneration: 1, contractRevision: 0 },
    { memberId: 'reviewer', displayName: 'Reviewer', role: 'reviewer', availability: 'available', sessionId: 's-reviewer', bindingGeneration: 1, contractRevision: 0 },
  ], archivedMemberIds: [], createdAt: 1, updatedAt: 1, leadMemberId: 'lead' }
}
async function fresh(roundLimit = 3): Promise<{ workspace: string; store: TaskStore; audit: unknown[]; taskId: string; attemptId: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b21-'))
  const team = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-1', teamId: 'team-1' })
  await team.open(); const opened = await team.open(); await team.commit('team-1', { expectedRevision: opened.revision, mutate: (value) => Object.assign(value, state()) })
  const audit: unknown[] = []; const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async (event) => { audit.push(event) } })
  const request: CreateTaskRequest = { title: 'B21 task', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['reviewed'], roundLimit, actor: 'lead' }
  const created = await store.createTask(request); const claimed = await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 }); await store.acknowledgeTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
  return { workspace, store, audit, taskId: created.task.id, attemptId: claimed.attempt.id }
}
async function cleanup(workspace: string): Promise<void> { await rm(workspace, { recursive: true, force: true }) }
const check = { command: 'test', status: 'passed' as const }

describe('B21 submission and review contract', () => {
  it('freezes report bytes and creates a new immutable submission each time', async () => {
    const value = await fresh(); const report = join(value.workspace, 'report.bin')
    try {
      await writeFile(report, Buffer.from([0, 255, 1]))
      const first = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.bin' }, summary: 'first', checks: [check] })
      const expected = createHash('sha256').update(Buffer.from([0, 255, 1])).digest('hex')
      await writeFile(report, Buffer.from([4, 5, 6]))
      const second = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.bin' }, summary: 'second', checks: [check] })
      expect(first.submission.id).not.toBe(second.submission.id)
      expect(first.submission.artifact).toMatchObject({ type: 'report', bodyRef: 'report.bin', bodyDigest: expected })
      // The bytes are kept by digest: the file was rewritten above, and the submission still reads
      // back as it was submitted.
      const frozen = first.submission.artifact.type === 'report' ? first.submission.artifact.blobPath : undefined
      expect(frozen).toBeDefined()
      expect(await value.store.readBlob(String(frozen))).toEqual(Buffer.from([0, 255, 1]))
      expect(createHash('sha256').update(await value.store.readBlob(String(frozen)) as Buffer).digest('hex')).toBe(expected)
      // The workspace file was rewritten, so reading the task says so instead of pretending the
      // submission describes what is on disk now.
      const read = await value.store.readTask(value.taskId)
      expect(read.submissions[0]?.drift).toEqual([{ path: 'report.bin', expected: expected, actual: createHash('sha256').update(Buffer.from([4, 5, 6])).digest('hex') }])
      // And the frozen copy is still the submitted one.
      expect(await value.store.readBlob(String(frozen))).toEqual(Buffer.from([0, 255, 1]))
      expect((await value.store.readSubmissions()).submissions[0]).toEqual(first.submission)
    } finally { await cleanup(value.workspace) }
  })

  it('rejects submit callers without the active assignee attempt without persistence or audit', async () => {
    const value = await fresh(); const beforeAudit = value.audit.length
    try {
      await expect(value.store.submitTask({ taskId: value.taskId, memberId: 'reviewer', sessionId: 's-reviewer', bindingGeneration: 1, artifact: { type: 'files', paths: ['missing'] }, summary: 'no', checks: [] })).rejects.toThrow(/assignee/u)
      expect((await value.store.readSubmissions()).submissions).toHaveLength(0); expect(value.audit.length).toBe(beforeAudit)
    } finally { await cleanup(value.workspace) }
  })

  it('rejects self review, stale submissions and PASS with high findings without writes', async () => {
    const value = await fresh(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'one'); const first = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'one', checks: [] })
      await expect(value.store.reviewTask({ taskId: value.taskId, submissionId: first.submission.id, reviewerMemberId: 'worker', verdict: 'pass', evidence: [check] })).rejects.toThrow(/assignee|review-route/u)
      await value.store.reviewTask({ taskId: value.taskId, submissionId: first.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision', findings: [{ severity: 'high', problem: 'bad', requiredFix: 'fix' }] })
      await writeFile(report, 'two'); const second = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'two', checks: [] })
      await expect(value.store.reviewTask({ taskId: value.taskId, submissionId: first.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [check] })).rejects.toThrow(/latest/u)
      await expect(value.store.reviewTask({ taskId: value.taskId, submissionId: second.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [check], findings: [{ severity: 'blocker', problem: 'still bad', requiredFix: 'repair' }] })).rejects.toThrow(/unresolved|blocker/u)
      expect((await value.store.readReviews()).rounds).toHaveLength(1); expect((await value.store.open()).tasks[0]?.status).toBe('in_progress')
    } finally { await cleanup(value.workspace) }
  })

  it('names the shape of a check and a finding when refusing them (first live run, F8)', async () => {
    const value = await fresh(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'one')
      // The member sent {"command":"npm test","result":"pass 3, fail 0"}: the refusal has
      // to say what a check looks like, not just that this one is invalid.
      const badCheck = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'one', checks: [{ command: 'npm test', result: 'pass 3, fail 0' }] as never }).then(() => undefined, (error: Error) => error.message)
      expect(badCheck).toContain('"status":"passed" | "failed"')
      expect(badCheck).toContain('command, result')

      const submission = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'ok', checks: [{ command: 'npm test', status: 'passed' }] })
      const badFinding = await value.store.reviewTask({ taskId: value.taskId, submissionId: submission.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision', findings: [{ severity: 'none-blocking', title: 'looks fine' }] as never }).then(() => undefined, (error: Error) => error.message)
      expect(badFinding).toContain('"severity":"low" | "medium" | "high" | "blocker"')
      expect(badFinding).toContain('severity, title')
      // And nothing was written while refusing.
      expect((await value.store.readSubmissions()).submissions).toHaveLength(1)
      expect((await value.store.readReviews()).rounds).toHaveLength(0)
    } finally { await cleanup(value.workspace) }
  })

  it('ends the attempt when a reviewer PASS completes the task (first live run, F5)', async () => {
    const value = await fresh(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'pass')
      const submission = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'ready', checks: [] })
      await value.store.reviewTask({ taskId: value.taskId, submissionId: submission.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [check] })
      const attempts = (await value.store.readAttempts()).attempts
      expect(attempts).toHaveLength(1)
      // Left active, this attempt makes the member look busy to the dispatcher for
      // every later task, and the review path used to leave exactly that behind.
      expect(attempts[0]?.status).toBe('completed')
      expect(value.audit.filter((event) => (event as { kind?: string }).kind === 'attempt/closed-stale')).toHaveLength(0)
    } finally { await cleanup(value.workspace) }
  })

  it('files the document when a reviewer PASS completes the task (second live run, F15)', async () => {
    const value = await fresh(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'pass')
      const submission = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'ready', checks: [] })
      const reviewed = await value.store.reviewTask({ taskId: value.taskId, submissionId: submission.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [check] })
      // The human path filed the document; this one used to leave `archivedPath` unset, so
      // a completed task stayed in the active list for good.
      expect(reviewed.task.archivedPath).toBeDefined()
      // And this is what makes the panel honest: the default listing leaves it out, so a
      // finished task can no longer sit under `Active` (listTasks excludes archived).
      expect(await value.store.listTasks()).toHaveLength(0)
      expect((await value.store.listTasks({ includeArchived: true }))[0]?.archivedPath).toBeDefined()
      expect(value.audit.filter((event) => (event as { kind?: string }).kind === 'task/archived')).toHaveLength(1)
      // The store reports the archive path as it wrote it (absolute) — resolve nothing.
      // The record holds the path relative to the team directory (the old shape was absolute).
      const teamDirectory = join(value.workspace, '.dsh-live-teams', 'teams', 'team-1')
      const archived = await readFile(join(teamDirectory, reviewed.task.archivedPath as string), 'utf8')
      expect(archived.length).toBeGreaterThan(0)
    } finally { await cleanup(value.workspace) }
  })

  it('heals an attempt left active on an ended task, once, with an audit entry (F5)', async () => {
    const value = await fresh(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'pass')
      const submission = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'ready', checks: [] })
      await value.store.reviewTask({ taskId: value.taskId, submissionId: submission.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [check] })
      // Simulate the state the live run was stuck in: the task ended, the attempt did not.
      const attemptsFile = join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', 'attempts.json')
      const stored = JSON.parse(await readFile(attemptsFile, 'utf8')) as { attempts: { status: string }[] }
      stored.attempts[0]!.status = 'active'
      await writeFile(attemptsFile, JSON.stringify(stored))
      const healed = await value.store.closeTerminalAttempts()
      expect(healed.closed).toHaveLength(1)
      expect(healed.closed[0]).toMatchObject({ taskId: value.taskId, status: 'completed' })
      expect((await value.store.readAttempts()).attempts[0]?.status).toBe('completed')
      expect(value.audit.filter((event) => (event as { kind?: string }).kind === 'attempt/closed-stale')).toHaveLength(1)
      // Idempotent: nothing left to heal on the next pass.
      expect((await value.store.closeTerminalAttempts()).closed).toHaveLength(0)
    } finally { await cleanup(value.workspace) }
  })

  it('publishes PASS acceptance with the exact submission and terminal task state', async () => {
    const value = await fresh(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'pass'); const submission = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'ready', checks: [] })
      const result = await value.store.reviewTask({ taskId: value.taskId, submissionId: submission.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [check] })
      expect(result.task).toMatchObject({ status: 'completed', acceptedSubmissionId: submission.submission.id })
      expect(value.audit.filter((event) => (event as { kind?: string }).kind === 'task/accepted')).toHaveLength(1)
      await expect(value.store.reviewTask({ taskId: value.taskId, submissionId: submission.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision' })).rejects.toThrow(/completed|terminal/u)
    } finally { await cleanup(value.workspace) }
  })

  it('enforces round limit then records escalation, waiting state, and lead delivery', async () => {
    const delivered: unknown[] = []; const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b21-esc-')); await rm(workspace, { recursive: true, force: true })
    const value = await fresh(1); const report = join(value.workspace, 'report.md')
    try {
      const store = createTaskStore({ workspacePath: value.workspace, teamId: 'team-1', appendAudit: async (event) => { value.audit.push(event) }, deliverEscalation: async (event) => { delivered.push(event) } })
      await writeFile(report, 'esc'); const first = await store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'esc', checks: [] })
      await store.reviewTask({ taskId: value.taskId, submissionId: first.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision', findings: [{ severity: 'blocker', problem: 'blocked', requiredFix: 'tried fix' }] })
      await writeFile(report, 'esc2'); const second = await store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'esc2', checks: [] })
      await expect(store.reviewTask({ taskId: value.taskId, submissionId: second.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision' })).rejects.toThrow(/round limit.*escalate/u)
      const escalated = await store.reviewTask({ taskId: value.taskId, submissionId: second.submission.id, reviewerMemberId: 'reviewer', verdict: 'escalate', findings: [{ severity: 'blocker', problem: 'blocked', requiredFix: 'tried fix' }] })
      expect(escalated.task.status).toBe('waiting'); expect(delivered).toHaveLength(1); expect((delivered[0] as { leadMemberId: string }).leadMemberId).toBe('lead')
      expect((await store.readTask(value.taskId)).rounds).toHaveLength(2)
    } finally { await cleanup(value.workspace) }
  })
})

describe('the reviewer is told when a submission arrives', () => {
  it('sends the review request along the route the lead froze', async () => {
    // Handing the submission over used to be the member's job alone: on a live stand one submission
    // waited six and a half minutes for a human to notice, while the member that did message its
    // reviewer was accepted in thirty-one seconds. The route is part of the task contract and cannot
    // be edited once work starts, so the handoff can only go where the lead sent it.
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b21-handoff-'))
    const sent: { reviewer: string; assignee: string; taskId: string; submissionId: string }[] = []
    try {
      const team = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-1', teamId: 'team-1' })
      await team.open()
      // The members the harness's own helper seeds: an assignee and a reviewer must exist.
      const opened = await team.open()
      await team.commit('team-1', { expectedRevision: opened.revision, mutate: (value) => Object.assign(value, state()) })
      const store = createTaskStore({
        workspacePath: workspace,
        teamId: 'team-1',
        appendAudit: async () => undefined,
        deliverReviewRequest: async (request) => { sent.push(request) },
      })
      const created = await store.createTask({ title: 'Handoff', kind: 'research', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['ok'], actor: 'human:desktop' })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      const report = join(workspace, 'handoff.md')
      await writeFile(report, '# handoff\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'handoff.md' }, summary: 'ready for review', checks: [] })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ reviewer: 'reviewer', assignee: 'worker', taskId: created.task.id, submissionId: submitted.submission.id })

      // A report route has no reviewer to wake: the human decides, and the panel says so.
      const humanTask = await store.createTask({ title: 'For the human', kind: 'research', assignee: 'reviewer', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'human:desktop' })
      await store.claimTask({ taskId: humanTask.task.id, memberId: 'reviewer', sessionId: 's-reviewer', bindingGeneration: 1 })
      await writeFile(report, '# human\n')
      await store.submitTask({ taskId: humanTask.task.id, memberId: 'reviewer', sessionId: 's-reviewer', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'handoff.md' }, summary: 'for the human', checks: [] })
      expect(sent).toHaveLength(1)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
