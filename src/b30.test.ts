import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitChangedPaths, parsePorcelainZ } from './changed-paths.js'
import { snapshotTree } from './tree-snapshot.js'
import { evaluateTask, projectDispatch } from './dispatch.js'
import { literalPrefix, normalizeScope, normalizeScopePath, outsideScope, scopeConflict } from './scope.js'
import { createTaskStore, type TaskStore, type TeamTask } from './task-store.js'
import { createMailbox, type CommandQueueLike } from './mailbox.js'
import { createDispatcher } from './dispatch.js'
import { TeamStore, type MemberRecord, type TeamState } from './team-store.js'

function queue(): { queue: CommandQueueLike } {
  const records = new Map<string, { commandId: string; idempotencyKey: string; sessionId: string; bindingGeneration: number; mode: 'queue' | 'steer'; requestId: string; state: 'admitted'; receipt: string; failureCode: undefined; failureDetail: undefined; revision: number }>()
  return {
    queue: {
      admit: async (request) => {
        const existing = records.get(request.idempotencyKey)
        if (existing !== undefined) return { record: existing, duplicate: true }
        const record = { commandId: `command-${String(records.size + 1)}`, idempotencyKey: request.idempotencyKey, sessionId: request.sessionId, bindingGeneration: request.bindingGeneration, mode: request.mode, requestId: request.idempotencyKey, state: 'admitted' as const, receipt: 'accepted', failureCode: undefined, failureDetail: undefined, revision: 1 }
        records.set(request.idempotencyKey, record)
        return { record, duplicate: false }
      },
      dispatch: async (commandId: string) => {
        const found = [...records.values()].find((record) => record.commandId === commandId)
        if (found === undefined) throw new Error('missing test command')
        return found
      },
    },
  }
}

const member = (memberId: string, role = 'builder'): MemberRecord => ({ memberId, displayName: memberId, role, availability: 'available', sessionId: `s-${memberId}`, bindingGeneration: 1, contractRevision: 0 })
function teamState(members: MemberRecord[]): TeamState {
  return { schemaVersion: 1, revision: 1, teamId: 'team-1', workspaceId: 'ws', workspacePath: '/w', members, archivedMemberIds: [], createdAt: 1, updatedAt: 1, leadMemberId: 'lead' } as TeamState
}
function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return { id: 'task-1', teamId: 'team-1', title: 'Write it', kind: 'implementation', status: 'ready', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], roundLimit: 5, createdBy: 'lead', createdAt: 1, updatedAt: 1, revision: 1, ...overrides } as TeamTask
}

describe('B30 scope arithmetic', () => {
  it('normalises what can be honoured and refuses what cannot', () => {
    expect(normalizeScopePath('./packages//live-teams/src/')).toBe('packages/live-teams/src')
    expect(normalizeScopePath('docs\\gate.md')).toBe('docs/gate.md')
    expect(normalizeScopePath('/etc/passwd')).toBeUndefined()
    expect(normalizeScopePath('../outside')).toBeUndefined()
    expect(normalizeScopePath('C:/windows')).toBeUndefined()
    expect(normalizeScopePath('   ')).toBeUndefined()
    expect(normalizeScope(['src/**/*.ts', 'docs/**'])).toEqual(['src/**/*.ts', 'docs/**'])
    expect(normalizeScope(['src/a', 'src/a'])).toBeUndefined()
    expect(normalizeScope([])).toBeUndefined()
    expect(normalizeScope(Array.from({ length: 33 }, (_value, index) => `p/${String(index)}`))).toBeUndefined()
  })

  it('compares by segment prefix, conservatively for wildcards', () => {
    expect(literalPrefix('src/**/*.ts')).toBe('src')
    expect(literalPrefix('a/b*')).toBe('a')
    expect(literalPrefix('a/b/c')).toBe('a/b/c')
    // Segment boundaries only: a sibling whose name merely starts the same stays apart.
    expect(scopeConflict(['a/b'], ['a/bc'])).toBeUndefined()
    expect(scopeConflict(['a/b'], ['a/b/c'])).toMatchObject({ kind: 'overlap' })
    // A wildcard reduces to its literal prefix, so this reports an overlap a particular
    // run might not have produced — the safe direction.
    expect(scopeConflict(['src/**/*.ts'], ['src/client/App.tsx'])).toMatchObject({ kind: 'overlap' })
    expect(scopeConflict(['README.md'], ['docs/**'])).toBeUndefined()
  })

  it('reports a shared hotspot separately from a concrete overlap', () => {
    // Both sides touch the same shared file: the fact is an overlap, the advice differs.
    expect(scopeConflict(['package.json'], ['package.json'])).toMatchObject({ kind: 'shared' })
    // Touching a hotspot is not by itself a collision: the other task writes elsewhere.
    expect(scopeConflict(['package.json'], ['src/client/**'])).toBeUndefined()
    expect(scopeConflict(['package.json'], ['src/**'])).toBeUndefined()
    expect(scopeConflict(['src/a.ts'], ['src/b.ts'])).toBeUndefined()
    // A concrete overlap wins over the hotspot explanation: it is the more precise fact.
    expect(scopeConflict(['package.json', 'src/a.ts'], ['src/a.ts'])).toMatchObject({ kind: 'overlap', left: 'src/a.ts' })
  })

  it('lists what fell outside a declaration', () => {
    expect(outsideScope(['src/a.ts', 'src/b/c.ts', 'docs/x.md'], ['src/**'])).toEqual(['docs/x.md'])
    expect(outsideScope(['src/a.ts'], ['src'])).toEqual([])
  })

  it('parses git porcelain exactly, including renames', () => {
    expect(parsePorcelainZ(' M a.txt\u0000R  c.txt\u0000b.txt\u0000?? new.txt\u0000')).toEqual(['a.txt', 'c.txt', 'new.txt'])
    expect(parsePorcelainZ('')).toEqual([])
    expect(parsePorcelainZ('garbage\u0000')).toBeUndefined()
  })
})

describe('B30 declared paths in the contract', () => {
  async function fixture(): Promise<{ workspace: string; store: TaskStore; team: TeamStore }> {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b30-'))
    const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
    await team.open()
    const opened = await team.open()
    await team.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('reviewer', 'verifier')])) } })
    const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined })
    return { workspace, store, team }
  }
  const request = (overrides: Record<string, unknown> = {}) => ({ title: 'Write it', kind: 'implementation' as const, assignee: 'worker', route: { type: 'review' as const, reviewer: 'reviewer' }, acceptance: ['ok'], actor: 'lead', ...overrides })

  it('round-trips a declaration through create, read and the document', async () => {
    const value = await fixture()
    try {
      const created = await value.store.createTask(request({ paths: ['./src//client', 'docs/gate-b30.md'] }))
      expect(created.task.paths).toEqual(['src/client', 'docs/gate-b30.md'])
      const read = await value.store.readTask(created.task.id)
      expect(read.task.paths).toEqual(['src/client', 'docs/gate-b30.md'])
      expect(read.document).toContain('## Paths')
      expect(read.document).toContain('- `src/client`')
    } finally { await rm(value.workspace, { recursive: true, force: true }) }
  })

  it('refuses a declaration it cannot honour, and writes nothing', async () => {
    const value = await fixture()
    try {
      for (const paths of [['/etc/passwd'], ['../outside'], ['ok', 'ok'], [], Array.from({ length: 33 }, (_v, index) => `p/${String(index)}`)]) {
        await expect(value.store.createTask(request({ title: `bad ${String(paths.length)}`, paths }))).rejects.toThrow(/paths must be/u)
      }
      expect(await value.store.listTasks()).toHaveLength(0)
    } finally { await rm(value.workspace, { recursive: true, force: true }) }
  })

  it('edits the declaration while the task is open, and freezes it once work starts', async () => {
    const value = await fixture()
    try {
      const created = await value.store.createTask(request({ paths: ['src/a.ts'] }))
      const updated = await value.store.updateTask({ taskId: created.task.id, actor: 'lead', paths: ['src/a.ts', 'src/b.ts'] })
      expect(updated.changed).toContain('paths')
      expect(updated.task.paths).toEqual(['src/a.ts', 'src/b.ts'])
      const cleared = await value.store.updateTask({ taskId: created.task.id, actor: 'lead', paths: null })
      expect(cleared.task.paths).toBeUndefined()
      await value.store.updateTask({ taskId: created.task.id, actor: 'lead', paths: ['src/a.ts'] })
      await value.store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await expect(value.store.updateTask({ taskId: created.task.id, actor: 'lead', paths: ['src/other.ts'] })).rejects.toThrow(/cannot be updated in status/u)
    } finally { await rm(value.workspace, { recursive: true, force: true }) }
  })

  it('records what actually changed at submission, and says when it cannot tell', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b30-scope-'))
    try {
      const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await team.open()
      const opened = await team.open()
      await team.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other'), member('verifier', 'verifier'), member('spare'), member('spare2')])) } })
      const audit: { kind?: string }[] = []
      // The reported changes are what git would have said; each submission sets its own.
      let changed: readonly string[] | undefined = []
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async (event) => { audit.push(event as { kind?: string }) }, changedPaths: async () => changed })
      await writeFile(join(workspace, 'report.md'), 'bytes')
      const submit = async (taskId: string, memberId: string, body: string) => {
        await store.claimTask({ taskId, memberId, sessionId: `s-${memberId}`, bindingGeneration: 1 })
        await store.acknowledgeTask({ taskId, memberId, sessionId: `s-${memberId}`, bindingGeneration: 1 })
        await writeFile(join(workspace, body), 'bytes')
        return await store.submitTask({ taskId, memberId, sessionId: `s-${memberId}`, bindingGeneration: 1, artifact: { type: 'report', bodyRef: body }, summary: 'done', checks: [] })
      }

      // Stays inside the declaration.
      const clean = await store.createTask(request({ title: 'Clean', paths: ['src/**'], assignee: 'worker', route: { type: 'report', to: 'human' } }))
      changed = ['src/a.ts', 'src/b.ts']
      const cleanSubmission = await submit(clean.task.id, 'worker', 'report.md')
      expect(cleanSubmission.submission.scope).toMatchObject({ state: 'clean', declared: ['src/**'], changed: ['src/a.ts', 'src/b.ts'] })
      expect(audit.map((event) => event.kind)).not.toContain('submission/scope-violation')

      // Goes outside the declaration, and nobody else declared what it touched.
      const violating = await store.createTask(request({ title: 'Violating', paths: ['docs/**'], assignee: 'other', route: { type: 'report', to: 'human' } }))
      changed = ['docs/x.md', 'scripts/tool.mjs']
      const violatingSubmission = await submit(violating.task.id, 'other', 'report2.md')
      expect(violatingSubmission.submission.scope).toMatchObject({ state: 'violation', unexpected: ['scripts/tool.mjs'] })
      expect(audit.filter((event) => event.kind === 'submission/scope-violation')).toHaveLength(1)

      // Goes outside the declaration *into a scope another active task declared*: in one
      // shared tree the honest name for that is coexistence, not a proven file clash.
      const shared = await store.createTask(request({ title: 'Shared tree', paths: ['docs/**'], assignee: 'verifier', route: { type: 'report', to: 'human' } }))
      changed = ['src/c.ts']
      const sharedSubmission = await submit(shared.task.id, 'verifier', 'report3.md')
      expect(sharedSubmission.submission.scope).toMatchObject({ state: 'shared-tree', unexpected: ['src/c.ts'], sharedTree: ['src/c.ts'] })
      expect(audit.filter((event) => event.kind === 'submission/scope-shared-tree')).toHaveLength(1)
      expect(audit.filter((event) => event.kind === 'submission/scope-collision')).toHaveLength(0)

      // With nothing observable the record says so, instead of pretending it is clean.
      changed = undefined
      const blind = await store.createTask(request({ title: 'Unobservable', paths: ['src/**'], assignee: 'spare', route: { type: 'report', to: 'human' } }))
      const blindSubmission = await submit(blind.task.id, 'spare', 'report4.md')
      expect(blindSubmission.submission.scope).toMatchObject({ state: 'unchecked' })

      // A task that declares nothing is not checked at all: there is nothing to violate.
      const undeclared = await store.createTask(request({ title: 'Undeclared', assignee: 'spare2', route: { type: 'report', to: 'human' } }))
      changed = ['anything/at-all.txt']
      expect((await submit(undeclared.task.id, 'spare2', 'report5.md')).submission.scope).toBeUndefined()
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})

describe('B32 the scope record without git', () => {
  it('records a declared change as clean and an undeclared one as a violation, with mode files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b32-'))
    try {
      // A plain folder: no repository, no git anywhere in the path.
      await mkdir(join(workspace, 'packages', 'alpha'), { recursive: true })
      await writeFile(join(workspace, 'packages', 'alpha', 'keep.js'), 'export const kept = 1\n')
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open(); const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other')])) } })
      const store = createTaskStore({
        workspacePath: workspace,
        teamId: 'team-1',
        appendAudit: async () => undefined,
        workspaceMode: async () => 'files' as const,
        snapshotTree,
      })
      const created = await store.createTask({ title: 'Write it', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/alpha/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      // In scope, and a report body outside the tree (the rule of F11).
      await writeFile(join(workspace, 'packages', 'alpha', 'keep.js'), 'export const kept = 2\n')
      await mkdir(join(workspace, '.dsh-live-teams', 'reports'), { recursive: true })
      await writeFile(join(workspace, '.dsh-live-teams', 'reports', 'task.md'), 'report\n')
      const clean = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: '.dsh-live-teams/reports/task.md' }, summary: 'done', checks: [] })
      expect(clean.submission.scope).toMatchObject({ mode: 'files', state: 'clean' })
      expect(clean.submission.scope?.changed).toEqual(['packages/alpha/keep.js'])

      // A second task in the same folder: the member edits outside its declaration.
      const second = await store.createTask({ title: 'Other', kind: 'implementation', assignee: 'other', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/beta/**'] })
      await store.claimTask({ taskId: second.task.id, memberId: 'other', sessionId: 's-other', bindingGeneration: 1 })
      await writeFile(join(workspace, 'OUTSIDE.md'), 'not mine\n')
      await writeFile(join(workspace, '.dsh-live-teams', 'reports', 'task2.md'), 'report 2\n')
      const violation = await store.submitTask({ taskId: second.task.id, memberId: 'other', sessionId: 's-other', bindingGeneration: 1, artifact: { type: 'report', bodyRef: '.dsh-live-teams/reports/task2.md' }, summary: 'done', checks: [] })
      expect(violation.submission.scope).toMatchObject({ mode: 'files', state: 'violation', unexpected: ['OUTSIDE.md'] })
      // A deletion is a change too, and the fingerprint was taken at claim time.
      await rm(join(workspace, 'OUTSIDE.md'))
      await store.claimTask({ taskId: second.task.id, memberId: 'other', sessionId: 's-other', bindingGeneration: 1 }).catch(() => undefined)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('reports an unwatchable folder as unchecked with a reason, never as clean', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b32-blind-'))
    try {
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open(); const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other')])) } })
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined, workspaceMode: async () => 'files' as const })
      const created = await store.createTask({ title: 'Blind', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['src/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'report.md'), 'report\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      // No snapshot port: the record says it could not look, and why.
      expect(submitted.submission.scope).toMatchObject({ state: 'unchecked', reason: 'unreadable', mode: 'files' })
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('prunes fingerprints whose attempt is no longer running', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b32-prune-'))
    try {
      await mkdir(join(workspace, 'src'), { recursive: true })
      await writeFile(join(workspace, 'src', 'a.js'), 'export const a = 1\n')
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open(); const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other')])) } })
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined, workspaceMode: async () => 'files' as const, snapshotTree })
      const created = await store.createTask({ title: 'Snapshot', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['src/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      const snapshots = join(workspace, '.dsh-live-teams', 'teams', 'team-1', 'snapshots')
      expect((await readdir(snapshots)).length).toBe(1)
      // A running attempt keeps its fingerprint; a finished one loses it.
      expect(await store.pruneSnapshots()).toBe(0)
      await writeFile(join(workspace, 'report.md'), 'report\n')
      await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      await store.acceptTask({ taskId: created.task.id, actor: 'human:desktop' })
      expect(await store.pruneSnapshots()).toBe(1)
      expect((await readdir(snapshots)).length).toBe(0)
      expect(await store.pruneSnapshots()).toBe(0)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})

describe('B31 human intervention mid-attempt', () => {
  const members = [member('lead', 'lead'), member('worker'), member('other'), member('reviewer', 'verifier')]
  const team = teamState(members)
  const memberOf = (memberId: string): MemberRecord | undefined => team.members.find((entry) => entry.memberId === memberId)
  const marked = (overrides: Record<string, unknown> = {}) => ({ id: 'attempt-1', taskId: 'task-1', memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, generation: 1, status: 'active' as const, startedAt: 100, humanIntervenedAt: 200, humanIntervenedContractRevision: 3, revision: 2, ...overrides })

  it('stops automatic work until the contract catches up with the change', () => {
    const value = task({ id: 'task-1', revision: 9, contractRevision: 3, activeAttemptId: 'attempt-1' })
    const verdict = evaluateTask({ task: value, tasks: [value], attempts: [marked()] as never, team, paused: false, coding: 'automatic', memberOf })
    expect(verdict).toMatchObject({ decision: 'wait', reason: 'human-intervened' })
    expect(verdict.detail).toContain('directly')
    // A claim, a submission or a revocation bump the task *revision* and must NOT resolve
    // the mark: only restating the work does that.
    const bumpedOnly = task({ id: 'task-1', revision: 10, contractRevision: 3, activeAttemptId: 'attempt-1' })
    expect(evaluateTask({ task: bumpedOnly, tasks: [bumpedOnly], attempts: [marked()] as never, team, paused: false, coding: 'automatic', memberOf })).toMatchObject({ reason: 'human-intervened' })
    // A formal restatement bumps the contract revision, and the mark stops holding.
    const restated = task({ id: 'task-1', revision: 11, contractRevision: 4, activeAttemptId: 'attempt-1' })
    expect(evaluateTask({ task: restated, tasks: [restated], attempts: [marked()] as never, team, paused: false, coding: 'automatic', memberOf })).toMatchObject({ reason: 'attempt-active' })
  })

  it('unblocks a dependent once the accepted work settles the intervention (F17)', async () => {
    // The end-to-end shape of the bug: a human writes into the member's Session, the
    // attempt is marked, and the reviewer then accepts the work. That acceptance has to
    // restate the contract, or the dependent can never start and nothing can clear it.
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-f17-'))
    try {
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open(); const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other'), member('reviewer', 'verifier')])) } })
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined })
      const dependency = await store.createTask({ title: 'First', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['ok'], actor: 'lead', paths: ['src/**'] })
      const claimed = await store.claimTask({ taskId: dependency.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await store.acknowledgeTask({ taskId: dependency.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await store.markHumanIntervention(claimed.attempt.id, Date.now())
      const dependent = await store.createTask({ title: 'Second', kind: 'implementation', assignee: 'other', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['docs/**'], dependsOn: [dependency.task.id] })
      const before = evaluateTask({ task: dependent.task, tasks: await store.listTasks({ includeArchived: true }), attempts: (await store.readAttempts()).attempts, team: teamState(members), paused: false, coding: 'automatic', memberOf: (id) => teamState(members).members.find((entry) => entry.memberId === id) })
      expect(before).toMatchObject({ decision: 'wait', reason: 'dependency-open' })

      await writeFile(join(workspace, 'report.md'), 'accepted\n')
      const submission = await store.submitTask({ taskId: dependency.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      await store.reviewTask({ taskId: dependency.task.id, submissionId: submission.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [{ command: 'test', status: 'passed' }] })
      const settled = (await store.listTasks({ includeArchived: true })).find((entry) => entry.id === dependency.task.id)
      const after = evaluateTask({ task: dependent.task, tasks: await store.listTasks({ includeArchived: true }), attempts: (await store.readAttempts()).attempts, team: teamState(members), paused: false, coding: 'automatic', memberOf: (id) => teamState(members).members.find((entry) => entry.memberId === id) })
      expect(settled?.contractRevision).toBeGreaterThan(dependency.task.contractRevision ?? 0)
      expect(after).toMatchObject({ decision: 'assign', reason: 'ok' })
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('stops dependents of a dependency completed after a human changed it', () => {
    const dependency = task({ id: 'task-dep', title: 'First', status: 'completed', contractRevision: 5 })
    const dependent = task({ id: 'task-2', title: 'Second', assignee: 'other', dependsOn: ['task-dep'], revision: 1 })
    const attempts = [marked({ id: 'attempt-1', taskId: 'task-dep', humanIntervenedContractRevision: 5, status: 'completed' })]
    const verdict = evaluateTask({ task: dependent, tasks: [dependency, dependent], attempts: attempts as never, team, paused: false, coding: 'automatic', memberOf })
    expect(verdict).toMatchObject({ decision: 'wait', reason: 'human-intervened' })
    expect(verdict.detail).toContain('task-dep')
    // Once the dependency's contract is restated past the mark, the dependent goes on.
    const restated = task({ id: 'task-dep', title: 'First', status: 'completed', contractRevision: 6 })
    expect(evaluateTask({ task: dependent, tasks: [restated, dependent], attempts: attempts as never, team, paused: false, coding: 'automatic', memberOf })).toMatchObject({ decision: 'assign', reason: 'ok' })
  })

  it('marks an attempt once, and only when a human was actually observed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b31-store-'))
    try {
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open()
      const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other')])) } })
      const audit: { kind?: string }[] = []
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async (event) => { audit.push(event as { kind?: string }) } })
      const created = await store.createTask({ title: 'Write it', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead' })
      const claimed = await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      const first = await store.markHumanIntervention(claimed.attempt.id, 1000)
      expect(first.changed).toBe(true)
      // The mark records the revision at *mark* time: claiming has already bumped it.
      expect(first.attempt).toMatchObject({ humanIntervenedAt: 1000, humanIntervenedContractRevision: (await store.listTasks())[0]?.contractRevision })
      const second = await store.markHumanIntervention(claimed.attempt.id, 2000)
      expect(second.changed).toBe(false)
      expect(second.attempt.humanIntervenedAt).toBe(1000)
      expect(audit.filter((event) => event.kind === 'attempt/human-intervened')).toHaveLength(1)
      // It survives the round trip through the file and the detail projection.
      const detail = await store.readTask(created.task.id)
      expect(detail.attempts).toHaveLength(1)
      expect(detail.attempts[0]).toMatchObject({ humanIntervenedAt: 1000 })
      expect(store.latestAttemptForTaskSync(created.task.id)).toMatchObject({ humanIntervenedAt: 1000 })
      await expect(store.markHumanIntervention('attempt-missing', 1)).rejects.toThrow(/unknown attempt/u)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('reads a pre-rename scope record as shared-tree (F10)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b30-legacy-'))
    try {
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open(); const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other')])) } })
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined })
      const created = await store.createTask({ title: 'Legacy', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['docs/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'r.md'), 'report body\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'r.md' }, summary: 'ok', checks: [] })
      // Rewrite the record the way the previous build wrote it.
      const file = join(workspace, '.dsh-live-teams', 'teams', 'team-1', 'submissions.json')
      const state = JSON.parse(await readFile(file, 'utf8')) as { submissions: { id: string; scope?: Record<string, unknown> }[] }
      const entry = state.submissions.find((item) => item.id === submitted.submission.id)
      entry!.scope = { declared: ['docs/**'], changed: ['src/x.ts'], unexpected: ['src/x.ts'], collision: ['src/x.ts'], state: 'collision' }
      await writeFile(file, JSON.stringify(state))
      const read = await store.readTask(created.task.id)
      expect(read.submissions[0]?.scope).toMatchObject({ state: 'shared-tree', sharedTree: ['src/x.ts'] })
      expect((read.submissions[0]?.scope as Record<string, unknown> | undefined)?.collision).toBeUndefined()
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('records a files artifact literally, so a submission cannot whitelist an edit (F7)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b30-artifact-'))
    try {
      // A real repository: the scope record is about what git sees, so the test writes
      // the same kind of change the live run did.
      const run = (args: string[]): void => { execFileSync('git', ['-C', workspace, ...args]) }
      run(['init', '-q', '.'])
      await mkdir(join(workspace, 'packages', 'alpha'), { recursive: true })
      await writeFile(join(workspace, 'packages', 'alpha', 'keep.js'), 'export const kept = 1\n')
      run(['add', '-A']); run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open(); const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other')])) } })
      const audit: { kind?: string }[] = []
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async (event) => { audit.push(event as { kind?: string }) }, changedPaths: gitChangedPaths })
      const created = await store.createTask({ title: 'Write it', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/alpha/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      // The member edits one file in scope and one outside it, then submits a `files`
      // artifact naming both. Excluding the artifact's own paths used to report this as
      // `clean` with an empty change set — the record then said nothing had happened.
      await writeFile(join(workspace, 'packages', 'alpha', 'keep.js'), 'export const kept = 2\n')
      await writeFile(join(workspace, 'OUTSIDE.md'), 'not mine to touch\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'files', paths: ['packages/alpha/keep.js', 'OUTSIDE.md'] }, summary: 'done', checks: [] })
      expect(submitted.submission.scope).toMatchObject({ state: 'violation' })
      expect([...(submitted.submission.scope?.changed ?? [])].sort()).toEqual(['OUTSIDE.md', 'packages/alpha/keep.js'])
      expect(submitted.submission.scope?.unexpected).toEqual(['OUTSIDE.md'])
      expect(audit.some((event) => event.kind === 'submission/scope-violation')).toBe(true)
      // A report artifact is different: the report itself is not the task's work.
      const second = await store.createTask({ title: 'Report it', kind: 'implementation', assignee: 'other', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/beta/**'] })
      await store.claimTask({ taskId: second.task.id, memberId: 'other', sessionId: 's-other', bindingGeneration: 1 })
      await writeFile(join(workspace, 'findings.md'), 'report body\n')
      const reported = await store.submitTask({ taskId: second.task.id, memberId: 'other', sessionId: 's-other', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'findings.md' }, summary: 'report', checks: [] })
      expect(reported.submission.scope?.changed).not.toContain('findings.md')
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('is observed by the reconciler, audited once, and read by the member', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b31-pass-'))
    try {
      const teamStore = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await teamStore.open()
      const opened = await teamStore.open()
      await teamStore.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('other')])) } })
      const audit: { kind?: string }[] = []
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async (event) => { audit.push(event as { kind?: string }) } })
      const created = await store.createTask({ title: 'Write it', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['src/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      const { queue: commandQueue } = queue()
      const mailbox = createMailbox({ workspacePath: workspace, teamId: 'team-1', queue: commandQueue, listRecipients: async () => [], appendAudit: async () => undefined })
      let observed: boolean | undefined = true
      const dispatcher = createDispatcher({
        workspacePath: workspace, teamId: 'team-1', readTeam: async () => await teamStore.open(), taskStore: store, mailbox,
        appendAudit: async (event) => { audit.push(event as { kind?: string }) },
        codingDispatch: 'automatic', humanActivity: async () => observed, sweepIntervalMs: 3_600_000,
      })
      try {
        const first = await dispatcher.reconcile('test')
        expect(first.intervened).toHaveLength(1)
        expect(audit.filter((event) => event.kind === 'attempt/human-intervened')).toHaveLength(1)
        // Idempotent across passes: the mark is already there.
        expect((await dispatcher.reconcile('test')).intervened).toHaveLength(0)
        expect(audit.filter((event) => event.kind === 'attempt/human-intervened')).toHaveLength(1)
        // A composition that cannot observe it must not pretend nobody was there.
        observed = undefined
        const blind = createDispatcher({
          workspacePath: workspace, teamId: 'team-1', readTeam: async () => await teamStore.open(), taskStore: store, mailbox,
          appendAudit: async () => undefined, codingDispatch: 'automatic', humanActivity: async () => undefined, sweepIntervalMs: 3_600_000,
        })
        try { expect((await blind.reconcile('test')).intervened).toHaveLength(0) } finally { await blind.stop() }
      } finally { await dispatcher.stop() }
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})

describe('B30 parallel-write gate', () => {
  const members = [member('lead', 'lead'), member('worker'), member('other'), member('reviewer', 'verifier')]
  const team = teamState(members)
  const memberOf = (memberId: string): MemberRecord | undefined => team.members.find((entry) => entry.memberId === memberId)
  const active = [{ id: 'attempt-1', taskId: 'task-active', memberId: 'other', status: 'active' as const }]
  const evaluate = (value: TeamTask, tasks: TeamTask[]) => evaluateTask({ task: value, tasks, attempts: active as never, team, paused: false, coding: 'automatic', memberOf })

  it('starts two writers whose declared scopes are disjoint', () => {
    const activeTask = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other', paths: ['packages/a/**'] })
    const candidate = task({ id: 'task-2', title: 'Candidate', paths: ['packages/b/**'] })
    expect(evaluate(candidate, [activeTask, candidate])).toMatchObject({ decision: 'assign', reason: 'ok' })
  })

  it('refuses to start a writer whose scope intersects an active one', () => {
    const activeTask = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other', paths: ['packages/a/**'] })
    const candidate = task({ id: 'task-2', title: 'Candidate', paths: ['packages/a/client/x.ts'] })
    const verdict = evaluate(candidate, [activeTask, candidate])
    expect(verdict).toMatchObject({ decision: 'wait', reason: 'paths-overlap' })
    expect(verdict.detail).toContain('task-active')
    expect(verdict.detail).toContain('Active')
  })

  it('asks for a declaration when an unknown scope would meet an active writer', () => {
    const activeTask = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other', paths: ['packages/a/**'] })
    const candidate = task({ id: 'task-2', title: 'Candidate' })
    expect(evaluate(candidate, [activeTask, candidate])).toMatchObject({ decision: 'wait', reason: 'paths-undeclared' })
    // The other direction: the active writer declares nothing, so its scope is unknown.
    const blind = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other' })
    const declared = task({ id: 'task-2', title: 'Candidate', paths: ['packages/b/**'] })
    expect(evaluate(declared, [blind, declared])).toMatchObject({ decision: 'wait', reason: 'paths-overlap' })
  })

  it('names a shared hotspot instead of a file pair', () => {
    // Both writers touch the same shared file: same fact as an overlap, better advice.
    const activeTask = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other', paths: ['package.json', 'packages/a/**'] })
    const candidate = task({ id: 'task-2', title: 'Candidate', paths: ['package.json'] })
    const verdict = evaluate(candidate, [activeTask, candidate])
    expect(verdict).toMatchObject({ decision: 'wait', reason: 'paths-shared' })
    expect(verdict.detail).toContain('shared')
    // Touching a hotspot while the other writer stays elsewhere is not a collision.
    const elsewhere = task({ id: 'task-3', title: 'Elsewhere', paths: ['package.json'] })
    const other = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other', paths: ['packages/a/**'] })
    expect(evaluate(elsewhere, [other, elsewhere])).toMatchObject({ decision: 'assign', reason: 'ok' })
  })

  it('leaves a lone writer alone, and never involves read-only work', () => {
    const lone = task({ id: 'task-2', title: 'Lone' })
    expect(evaluateTask({ task: lone, tasks: [lone], attempts: [], team, paused: false, coding: 'automatic', memberOf })).toMatchObject({ decision: 'assign', reason: 'ok' })
    const activeTask = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other', paths: ['packages/a/**'] })
    const research = task({ id: 'task-2', title: 'Read the docs', kind: 'research' })
    expect(evaluate(research, [activeTask, research])).toMatchObject({ decision: 'assign', reason: 'ok' })
    const reader = task({ id: 'task-active', title: 'Reading', kind: 'research', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other' })
    const writer = task({ id: 'task-2', title: 'Writer' })
    expect(evaluate(writer, [reader, writer])).toMatchObject({ decision: 'assign', reason: 'ok' })
  })

  it('reports the same verdict through the projection', () => {
    const activeTask = task({ id: 'task-active', title: 'Active', status: 'in_progress', activeAttemptId: 'attempt-1', assignee: 'other', paths: ['packages/a/**'] })
    const candidate = task({ id: 'task-2', title: 'Candidate', paths: ['packages/a/client/x.ts'] })
    const projection = projectDispatch({ tasks: [candidate], universe: [activeTask, candidate], attempts: active as never, team, memberOf, dispatch: { mode: 'auto', coding: 'automatic' } })
    expect(projection.evaluations.find((entry) => entry.taskId === 'task-2')).toMatchObject({ reason: 'paths-overlap' })
  })
})
