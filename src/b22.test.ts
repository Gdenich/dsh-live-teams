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

async function fixture(options: { callback?: (request: { assignee: string; taskId: string; note?: string }) => Promise<void>; direction?: (request: { assignee: string; taskId: string; instructions: string }) => Promise<void> } = {}): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b22-'))
  const team = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-1', teamId: 'team-1' })
  await team.open()
  const opened = await team.open()
  await team.commit('team-1', { expectedRevision: opened.revision, mutate: (value) => Object.assign(value, state()) })
  const audit: unknown[] = []
  const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async (event) => { audit.push(event) }, ...(options.callback === undefined ? {} : { deliverClosing: options.callback }), ...(options.direction === undefined ? {} : { deliverDirection: options.direction }) })
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

  it('refuses acceptance when the authored document is missing and leaves no archive or transition', async () => {
    const value = await fixture()
    try {
      const before = value.audit.length
      await expect(value.store.acceptTask({ taskId: value.taskId, actor: 'lead' })).rejects.toThrow(/waiting|status/u)
      expect(value.audit).toHaveLength(before)
      expect(await readdir(join(value.workspace, '.dsh-live-teams', 'teams', 'team-1', 'archive')).catch(() => [])).toEqual([])
    } finally { await cleanup(value.workspace) }
  })
})
