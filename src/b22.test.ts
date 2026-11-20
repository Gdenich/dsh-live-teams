import { mkdtemp, readFile, readdir, rename, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamStore, type TeamState } from './team-store.js'
import { createTaskStore, type CreateTaskRequest, type TaskStore } from './task-store.js'

function state(): TeamState {
  return { schemaVersion: 1, revision: 1, teamId: 'team-1', workspaceId: 'workspace-1', workspacePath: '/tmp', members: [
    { memberId: 'lead', displayName: 'Lead', role: 'lead', availability: 'available', sessionId: 's-lead', bindingGeneration: 1, contractRevision: 0 },
    { memberId: 'worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 's-worker', bindingGeneration: 1, contractRevision: 0 },
  ], archivedMemberIds: [], createdAt: 1, updatedAt: 1, leadMemberId: 'lead' }
}

type Fixture = { workspace: string; store: TaskStore; taskId: string; attemptId: string; audit: unknown[] }

async function fixture(options: { callback?: (request: { assignee: string; taskId: string; note?: string }) => Promise<void>; direction?: (request: { assignee: string; taskId: string; instructions: string }) => Promise<void>; cancellation?: (request: { assignee: string; taskId: string; reason: string }) => Promise<void> } = {}): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b22-'))
  const team = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-1', teamId: 'team-1' })
  await team.open()
  const opened = await team.open()
  await team.commit('team-1', { expectedRevision: opened.revision, mutate: (value) => Object.assign(value, state()) })
  const audit: unknown[] = []
  const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', interruptSession: async () => undefined, awaitQuiescence: async () => true, appendAudit: async (event) => { audit.push(event) }, ...(options.callback === undefined ? {} : { deliverClosing: options.callback }), ...(options.direction === undefined ? {} : { deliverDirection: options.direction }), ...(options.cancellation === undefined ? {} : { deliverCancellation: options.cancellation }) })
  const request: CreateTaskRequest = { title: 'B22 report task', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['The report is complete'], actor: 'lead', body: 'B22 task body' }
  const created = await store.createTask(request)
  const claimed = await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
  await store.acknowledgeTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
  return { workspace, store, taskId: created.task.id, attemptId: claimed.attempt.id, audit }
}

async function cleanup(workspace: string): Promise<void> { await rm(workspace, { recursive: true, force: true }) }
function eventKind(value: unknown): string | undefined { return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string' ? value.kind : undefined }

describe('B22 acceptance, revision and archive contract', () => {
  it('moves report submissions to waiting and leaves the active attempt owned by the assignee', async () => {
    const value = await fixture(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'report bytes')
      const submitted = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      expect((await value.store.open()).tasks[0]).toMatchObject({ status: 'waiting', assignee: 'worker', activeAttemptId: value.attemptId, latestSubmissionId: submitted.submission.id })
      expect((await value.store.readAttempts()).attempts[0]).toMatchObject({ id: value.attemptId, memberId: 'worker', status: 'active' })
    } finally { await cleanup(value.workspace) }
  })

  it('keeps an archived document readable after the workspace moves, and still reads legacy absolute paths', async () => {
    const value = await fixture(); const report = join(value.workspace, 'report.md')
    const moved = `${value.workspace}-moved`
    try {
      await writeFile(report, 'report bytes')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      const accepted = await value.store.acceptTask({ taskId: value.taskId, actor: 'lead' })
      const archivedPath = accepted.task.archivedPath as string
      expect(archivedPath.startsWith('archive/')).toBe(true)

      // The whole point of a relative record: the workspace can be somewhere else tomorrow.
      await rename(value.workspace, moved)
      const reopened = createTaskStore({ workspacePath: moved, teamId: 'team-1', appendAudit: async () => undefined })
      const archived = await reopened.listTasks({ includeArchived: true })
      expect(archived).toHaveLength(1)
      expect(await readFile(join(moved, '.dsh-live-teams', 'teams', 'team-1', archivedPath), 'utf8')).toContain('B22 task body')

      // And a record written before the change — an absolute path — is still honoured.
      const location = join(moved, '.dsh-live-teams', 'teams', 'team-1')
      const state = JSON.parse(await readFile(join(location, 'tasks.json'), 'utf8')) as { tasks: { id: string; archivedPath?: string }[] }
      const absolute = state.tasks.map((task) => task.id === accepted.task.id ? { ...task, archivedPath: join(location, archivedPath) } : task)
      await writeFile(join(location, 'tasks.json'), JSON.stringify({ ...state, tasks: absolute }))
      const legacy = createTaskStore({ workspacePath: moved, teamId: 'team-1', appendAudit: async () => undefined })
      // Read through the store, not around it: this exercises the validator and the resolver, which
      // is where an absolute record written by an older build is either honoured or rejected.
      expect((await legacy.readTask(accepted.task.id)).document).toContain('B22 task body')
      expect(await legacy.listTasks({ includeArchived: true })).toHaveLength(1)
    } finally {
      await rm(value.workspace, { recursive: true, force: true })
      await rm(moved, { recursive: true, force: true })
    }
  })

  it('accepts once, completes the attempt, stores the latest submission id, and archives exact task content', async () => {
    const value = await fixture(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'report bytes')
      const submission = await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      const accepted = await value.store.acceptTask({ taskId: value.taskId, actor: 'lead', note: 'well done' })
      expect(accepted.task).toMatchObject({ status: 'completed', acceptedSubmissionId: submission.submission.id, archivedPath: accepted.archivedPath, activeAttemptId: value.attemptId })
      expect((await value.store.readAttempts()).attempts[0]).toMatchObject({ id: value.attemptId, status: 'completed' })
      // Relative to the team directory, so a moved workspace keeps working records.
      expect(accepted.archivedPath.startsWith('archive/')).toBe(true)
      expect(await readFile(join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', accepted.archivedPath), 'utf8')).toContain('B22 task body')
      await expect(access(join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', 'tasks', `${value.taskId}.md`))).rejects.toThrow()
      expect(value.audit.filter((event) => eventKind(event) === 'task/accepted')).toHaveLength(1)
      expect(value.audit.filter((event) => eventKind(event) === 'task/archived')).toHaveLength(1)
      expect(value.audit.filter((event) => eventKind(event) === 'task/accepted')[0]).toMatchObject({ actor: 'lead', archivedPath: accepted.archivedPath })
      expect(value.audit.filter((event) => eventKind(event) === 'task/archived')[0]).toMatchObject({ actor: 'lead', archivedPath: accepted.archivedPath })
    } finally { await cleanup(value.workspace) }
  })

  it('hides archived tasks by default and includes them newest-first when requested', async () => {
    const value = await fixture(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'report bytes')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      const accepted = await value.store.acceptTask({ taskId: value.taskId, actor: 'lead' })
      expect(await value.store.listTasks()).toEqual([])
      expect(await value.store.listTasks(true)).toEqual([expect.objectContaining({ id: value.taskId, archivedPath: accepted.archivedPath })])
      await expect(value.store.readTask(value.taskId)).resolves.toMatchObject({ task: { archivedPath: accepted.archivedPath }, document: expect.stringContaining('B22 task body') })
    } finally { await cleanup(value.workspace) }
  })

  it('refuses non-lead acceptance and revision without writes or audit', async () => {
    const value = await fixture(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'report bytes')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      const beforeTasks = JSON.stringify(await value.store.open()); const beforeAttempts = JSON.stringify(await value.store.readAttempts()); const beforeAudit = value.audit.length
      await expect(value.store.acceptTask({ taskId: value.taskId, actor: 'worker' })).rejects.toThrow(/only the lead/u)
      await expect(value.store.reviseTask({ taskId: value.taskId, actor: 'worker', instructions: 'fix it' })).rejects.toThrow(/only the lead/u)
      expect(JSON.stringify(await value.store.open())).toBe(beforeTasks); expect(JSON.stringify(await value.store.readAttempts())).toBe(beforeAttempts); expect(value.audit).toHaveLength(beforeAudit)
    } finally { await cleanup(value.workspace) }
  })

  it('refuses repeated acceptance and revision of a non-waiting task without audit', async () => {
    const value = await fixture(); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'report bytes')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      await value.store.acceptTask({ taskId: value.taskId, actor: 'lead' }); const before = value.audit.length
      await expect(value.store.acceptTask({ taskId: value.taskId, actor: 'lead' })).rejects.toThrow(/completed|archived/u)
      await expect(value.store.reviseTask({ taskId: value.taskId, actor: 'lead', instructions: 'again' })).rejects.toThrow(/status/u)
      expect(value.audit).toHaveLength(before)
    } finally { await cleanup(value.workspace) }
  })

  it('revises waiting work to in_progress, delivers direction, and refuses empty instructions', async () => {
    const directions: unknown[] = []
    const value = await fixture({ direction: async (request) => { directions.push(request) } }); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'report bytes')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      await expect(value.store.reviseTask({ taskId: value.taskId, actor: 'lead', instructions: '  fix the evidence  ' })).resolves.toMatchObject({ task: { status: 'in_progress' } })
      expect(directions).toEqual([{ assignee: 'worker', taskId: value.taskId, instructions: 'fix the evidence' }])
      const before = value.audit.length
      await expect(value.store.reviseTask({ taskId: value.taskId, actor: 'lead', instructions: '   ' })).rejects.toThrow(/non-empty/u)
      expect(value.audit).toHaveLength(before)
    } finally { await cleanup(value.workspace) }
  })

  it('keeps acceptance durable when closing delivery fails after the lock', async () => {
    const value = await fixture({ callback: async () => { throw new Error('delivery failed') } }); const report = join(value.workspace, 'report.md')
    try {
      await writeFile(report, 'report bytes')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      await expect(value.store.acceptTask({ taskId: value.taskId, actor: 'lead' })).resolves.toMatchObject({ task: { status: 'completed' } })
      expect((await value.store.listTasks(true))[0]).toMatchObject({ status: 'completed' })
    } finally { await cleanup(value.workspace) }
  })

  it('accepts a returned task whose submission is still undecided (found on a real stand)', async () => {
    // The human returned the task; the status went back to `in_progress` while the submission stayed
    // on the table. Acceptance read the status and refused, the panel read the status and showed only
    // "Release attempt" — a dead end with no way to close the task.
    const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { TeamStore } = await import('./team-store.js')
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-returned-'))
    try {
      const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await team.open(); const opened = await team.open()
      await team.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { state.members.push({ memberId: 'm-lead', displayName: 'Lead', role: 'lead', availability: 'available', bindingGeneration: 1, contractRevision: 0 }, { memberId: 'm-worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 's-worker', bindingGeneration: 1, contractRevision: 0 }); state.leadMemberId = 'm-lead' } })
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined })
      const created = await store.createTask({ title: 'Returned', kind: 'research', assignee: 'm-worker', route: { type: 'report', to: 'human' }, acceptance: ['notes'], actor: 'm-lead' })
      await store.claimTask({ taskId: created.task.id, memberId: 'm-worker', sessionId: 's-worker', bindingGeneration: 1 })
      await mkdir(join(workspace, '.dsh-live-teams', 'reports'), { recursive: true })
      await writeFile(join(workspace, '.dsh-live-teams', 'reports', `${created.task.id}.md`), '# report\n')
      await store.submitTask({ taskId: created.task.id, memberId: 'm-worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: `.dsh-live-teams/reports/${created.task.id}.md` }, summary: 'first', checks: [] })
      expect((await store.readTask(created.task.id)).task.awaitsDecision).toBe(true)

      const returned = await store.reviseTask({ taskId: created.task.id, actor: 'human:desktop', instructions: 'tighten it' })
      expect(returned.task.status).toBe('in_progress')
      // The return takes the decision away: the member owes a new submission.
      expect(returned.task.awaitsDecision).toBe(false)
      await expect(store.acceptTask({ taskId: created.task.id, actor: 'human:desktop' })).rejects.toThrow(/awaiting a decision/u)

      // And the member's next submission puts it back on the table, from any status.
      await store.submitTask({ taskId: created.task.id, memberId: 'm-worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: `.dsh-live-teams/reports/${created.task.id}.md` }, summary: 'second', checks: [] })
      expect((await store.readTask(created.task.id)).task.awaitsDecision).toBe(true)
      const accepted = await store.acceptTask({ taskId: created.task.id, actor: 'human:desktop' })
      expect(accepted.task.status).toBe('completed')
      expect(accepted.task.awaitsDecision).toBe(false)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('refuses acceptance when the authored document is missing and leaves no archive or transition', async () => {
    const value = await fixture()
    try {
      const before = value.audit.length
      // The refusal is about the fact, not the status: nothing awaits a decision here.
      await expect(value.store.acceptTask({ taskId: value.taskId, actor: 'lead' })).rejects.toThrow(/awaiting a decision|no submission/u)
      expect(value.audit).toHaveLength(before)
      expect(await readdir(join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', 'archive')).catch(() => [])).toEqual([])
    } finally { await cleanup(value.workspace) }
  })
})

describe('B22 closing a task by hand', () => {
  it('archives authored document bytes and delivers notification outside the store lock', async () => {
    let notifiedStatus: string | undefined
    const value = await fixture({ cancellation: async () => {
      notifiedStatus = (await value.store.readTask(value.taskId)).task.status
    } })
    try {
      const documentPath = join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', 'tasks', `${value.taskId}.md`)
      const authored = `${await readFile(documentPath, 'utf8')}\n## Authored note\n\nThis text is not a contract field. Пробелы  сохранены.\n`
      await writeFile(documentPath, authored)
      const report = join(value.workspace, 'evidence.md')
      await writeFile(report, 'frozen evidence')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'evidence.md' }, summary: 'submitted', checks: [] })
      const submissionBefore = (await value.store.readSubmissions()).submissions
      const result = await value.store.cancelTask({ taskId: value.taskId, actor: 'human:desktop', reason: 'superseded, not accepted' })
      if (result.archivedPath === undefined) throw new Error('missing archive')
      const archive = await readFile(join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', result.archivedPath), 'utf8')
      expect(archive.startsWith(authored)).toBe(true)
      expect(archive).toContain('Actor: human:desktop')
      expect(archive).toContain('Reason: superseded, not accepted')
      expect(notifiedStatus).toBe('cancelled')
      expect(result.task.acceptedSubmissionId).toBeUndefined()
      expect((await value.store.readSubmissions()).submissions).toEqual(submissionBefore)
    } finally { await cleanup(value.workspace) }
  })
  it('does not reconstruct a missing authored document and claim it was archived', async () => {
    let cancellations = 0
    const value = await fixture({ cancellation: async () => { cancellations += 1 } })
    try {
      const documentPath = join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', 'tasks', `${value.taskId}.md`)
      expect(documentPath.startsWith(`${value.workspace}/.dsh-live-teams/teams/team-1/tasks/`)).toBe(true)
      await rm(documentPath)
      await expect(value.store.cancelTask({ taskId: value.taskId, actor: 'lead', reason: 'archive requires authored bytes' })).rejects.toThrow(/document is missing/)
      const task = (await value.store.listTasks()).find((entry) => entry.id === value.taskId)
      if (task === undefined) throw new Error('missing parked task')
      expect(task.status).toBe('draft')
      expect(task.archivedPath).toBeUndefined()
      expect(cancellations).toBe(0)
    } finally { await cleanup(value.workspace) }
  })

  it('cancels a task that will never be submitted, and says why in the journal', async () => {
    // The model always had a `cancelled` status and no way to reach it: accept needs a submission
    // awaiting a decision, and work done by hand, dropped, or overtaken has none. On a live stand a
    // human closed three such tasks by editing their titles — the state never changed.
    const cancelled: { assignee: string; taskId: string; reason: string }[] = []
    const value = await fixture({ cancellation: async (request) => { cancelled.push(request) } })
    try {
      const result = await value.store.cancelTask({ taskId: value.taskId, actor: 'lead', reason: 'сделано руками, задача перекрыта' })
      expect(result.task.status).toBe('cancelled')
      expect(result.task.awaitsDecision).toBe(false)
      expect(result.task.archivedPath).toBeDefined()
      // The document is archived, as acceptance does, so the record survives the task.
      if (result.archivedPath === undefined) throw new Error('successful cancellation did not archive its document')
      expect(await readFile(join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', result.archivedPath), 'utf8')).toContain('B22 report task')
      expect(value.audit.some((event) => eventKind(event) === 'task/cancelled')).toBe(true)
      // Closing ends the attempt, so the member must be told — acceptance always has been.
      expect(cancelled).toHaveLength(1)
      expect(cancelled[0]).toMatchObject({ assignee: 'worker', taskId: value.taskId, reason: 'сделано руками, задача перекрыта' })
      // The attempt is closed with it: nobody is left holding a task that no longer exists.
      const attempts = await value.store.readAttempts()
      expect(attempts.attempts.find((entry) => entry.id === value.attemptId)?.status).not.toBe('active')
    } finally { await cleanup(value.workspace) }
  })

  it('refuses a cancellation with no reason, from a member, or on a finished task', async () => {
    const value = await fixture()
    try {
      await expect(value.store.cancelTask({ taskId: value.taskId, actor: 'lead', reason: '   ' })).rejects.toThrow(/why/)
      await expect(value.store.cancelTask({ taskId: value.taskId, actor: 'worker', reason: 'мне так удобнее' })).rejects.toThrow(/only the lead/)
      await value.store.cancelTask({ taskId: value.taskId, actor: 'human:desktop', reason: 'перекрыта' })
      await expect(value.store.cancelTask({ taskId: value.taskId, actor: 'lead', reason: 'ещё раз' })).rejects.toThrow(/already cancelled/)
    } finally { await cleanup(value.workspace) }
  })
})

describe('B22 unresolved integration is not silently discarded', () => {
  it('requires reconciliation before revision or cancellation', async () => {
    // A marker records uncertain Git side effects. Removing it does not undo an integration;
    // the existing reconciler must determine its outcome before another lifecycle decision.
    const value = await fixture()
    try {
      const tasksFile = join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', 'tasks.json')
      const markPending = async (): Promise<void> => {
        const state = JSON.parse(await readFile(tasksFile, 'utf8')) as { tasks: { id: string; integrationPending?: unknown }[] }
        for (const task of state.tasks) if (task.id === value.taskId) task.integrationPending = { baseRef: 'refs/heads/main', headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40), at: 1 }
        await writeFile(tasksFile, JSON.stringify(state, null, 2))
      }
      const report = join(value.workspace, 'b22-pending.md')
      await writeFile(report, 'report bytes')
      await value.store.submitTask({ taskId: value.taskId, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'b22-pending.md' }, summary: 'ready', checks: [] })
      await markPending()
      await expect(value.store.reviseTask({ taskId: value.taskId, actor: 'lead', instructions: 'one more thing' })).rejects.toThrow(/unresolved integration/)
      await expect(value.store.cancelTask({ taskId: value.taskId, actor: 'lead', reason: 'перекрыта' })).rejects.toThrow(/unresolved integration/)
      const persisted = JSON.parse(await readFile(tasksFile, 'utf8')) as { tasks: { id: string; integrationPending?: unknown }[] }
      expect(persisted.tasks.find((entry) => entry.id === value.taskId)?.integrationPending).toBeDefined()
    } finally { await cleanup(value.workspace) }
  })
})
