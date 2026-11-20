import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseInfo, commitPaths, commitPathsOf, integrateCommit, pinCommit, refTip } from './git-artifacts.js'
import { gitChangedPaths, gitCommittedPaths } from './changed-paths.js'
import { createTaskStore, type TaskStore } from './task-store.js'
import { TeamStore, type MemberRecord, type TeamState } from './team-store.js'

/**
 * Phase 6 (ADR 0006): a submission in Git mode is a commit the plugin builds from exactly the
 * submitted paths, and acceptance integrates it with a compare-and-swap against the base the
 * review was made on.
 */
const member = (memberId: string, role = 'builder'): MemberRecord => ({ memberId, displayName: memberId, role, availability: 'available', sessionId: `s-${memberId}`, bindingGeneration: 1, contractRevision: 0 })
function teamState(members: MemberRecord[]): TeamState {
  return { schemaVersion: 1, revision: 1, teamId: 'team-1', workspaceId: 'ws', workspacePath: '/w', members, archivedMemberIds: [], createdAt: 1, updatedAt: 1, leadMemberId: 'lead' } as TeamState
}
const gitPorts = {
  base: async (workspacePath: string) => await baseInfo(workspacePath),
  tip: async (workspacePath: string, ref: string) => await refTip(workspacePath, ref),
  commit: async (workspacePath: string, base: { ref: string; sha: string } | undefined, request: { paths: readonly string[]; message: string; author: { name: string; email: string } }) => await commitPaths(workspacePath, base, request),
  pin: async (workspacePath: string, ref: string, sha: string) => await pinCommit(workspacePath, ref, sha),
  integrate: async (workspacePath: string, ref: string, headSha: string, expectedTip: string | undefined, commitPaths?: readonly string[]) => await integrateCommit(workspacePath, ref, headSha, expectedTip, commitPaths),
  changedBetween: async (workspacePath: string, fromSha: string, toSha: string) => await commitPathsOf(workspacePath, fromSha, toSha),
}

async function repository(prefix: string): Promise<{ workspace: string; store: TaskStore; git: (args: string[]) => string }> {
  const workspace = await mkdtemp(join(tmpdir(), prefix))
  const git = (args: string[]): string => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' })
  await mkdir(join(workspace, 'packages', 'a', 'src'), { recursive: true })
  await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 1\n')
  await writeFile(join(workspace, 'packages', 'a', 'README.md'), 'readme\n')
  await writeFile(join(workspace, 'root.md'), 'root\n')
  await writeFile(join(workspace, '.gitignore'), 'node_modules\n')
  git(['init', '-q', '-b', 'main', '.'])
  git(['add', '-A'])
  git(['-c', 'user.email=base@check', '-c', 'user.name=base', 'commit', '-qm', 'base'])
  const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
  await team.open(); const opened = await team.open()
  await team.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState([member('lead', 'lead'), member('worker'), member('reviewer', 'verifier')])) } })
  const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined, workspaceMode: async () => 'git' as const, changedPaths: gitChangedPaths, committedPaths: gitCommittedPaths, git: gitPorts })
  return { workspace, store, git }
}

describe('Phase 6 Git-bound submissions', () => {
  it('freezes the submitted paths into a commit without moving the branch or the index', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-')
    try {
      const base = await baseInfo(workspace)
      const created = await store.createTask({ title: 'Change one', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 2\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'files', paths: ['packages/a/src/one.ts'] }, summary: 'changed one', checks: [] })
      const frozen = submitted.submission.git
      expect(frozen).toMatchObject({ baseRef: 'refs/heads/main', baseTipSha: base?.sha, commitPaths: ['packages/a/src/one.ts'] })
      expect(frozen?.headSha).toMatch(/^[0-9a-f]{40}$/u)
      // The working tree's own story is still recorded, and now the commit's contents are too.
      expect(submitted.submission.scope).toMatchObject({ committed: ['packages/a/src/one.ts'], mode: 'git' })
      // Nothing moved: the branch is where it was, the index is as dirty as the member left it, and
      // the commit carries every other file of the base untouched.
      expect(git(['rev-parse', 'refs/heads/main']).trim()).toBe(base?.sha)
      expect(git(['show', `${frozen?.headSha}:packages/a/README.md`]).trim()).toBe('readme')
      expect(git(['show', `${frozen?.headSha}:packages/a/src/one.ts`]).trim()).toBe('export const one = 2')
      expect(git(['diff', '--name-only', `${base?.sha}..${frozen?.headSha}`]).trim()).toBe('packages/a/src/one.ts')
      // The reviewed artifact is pinned against garbage collection.
      expect(git(['rev-parse', `refs/live-teams/${created.task.id}/g1-${String(frozen?.headSha).slice(0, 12)}`]).trim()).toBe(frozen?.headSha)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('integrates on acceptance, and refuses with STALE_BASE when the base moved', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-stale-')
    try {
      const base = await baseInfo(workspace)
      const created = await store.createTask({ title: 'Change one', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 2\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'files', paths: ['packages/a/src/one.ts'] }, summary: 'changed one', checks: [] })
      const frozen = submitted.submission.git

      // A foreign commit lands on the base between review and acceptance.
      await writeFile(join(workspace, 'other.md'), 'somebody else\n')
      git(['add', 'other.md'])
      git(['-c', 'user.email=other@check', '-c', 'user.name=other', 'commit', '-qm', 'foreign'])
      const moved = git(['rev-parse', 'refs/heads/main']).trim()

      await expect(store.acceptTask({ taskId: created.task.id, actor: 'human:desktop' })).rejects.toThrow(/base moved since the review/u)
      expect(git(['rev-parse', 'refs/heads/main']).trim()).toBe(moved)
      expect((await store.listTasks({ includeArchived: true }))[0]?.status).toBe('waiting')

      expect(frozen?.baseTipSha).toBe(base?.sha)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('freezes a commit for a coding task that submits a report (F20 of the fourth live run)', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-report-')
    try {
      const base = await baseInfo(workspace)
      const created = await store.createTask({ title: 'Change one', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 3\n')
      await mkdir(join(workspace, '.dsh-live-teams', 'reports'), { recursive: true })
      await writeFile(join(workspace, '.dsh-live-teams', 'reports', 'task.md'), 'what I did\n')
      // A report artifact, as every live coding submission has been so far: the commit comes from
      // the paths the member actually changed inside its declaration, not from the artifact shape.
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: '.dsh-live-teams/reports/task.md' }, summary: 'changed one', checks: [] })
      expect(submitted.submission.artifact.type).toBe('report')
      expect(submitted.submission.git).toMatchObject({ baseRef: 'refs/heads/main', baseTipSha: base?.sha, commitPaths: ['packages/a/src/one.ts'] })
      expect(submitted.submission.scope?.committed).toEqual(['packages/a/src/one.ts'])
      expect(git(['diff', '--name-only', `${base?.sha}..${String(submitted.submission.git?.headSha)}`]).trim()).toBe('packages/a/src/one.ts')
      // And it integrates like any other reviewed commit — here through the reviewer's verdict,
      // because a review route completes on PASS rather than on the human's acceptance.
      const passed = await store.reviewTask({ taskId: created.task.id, submissionId: submitted.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [{ command: 'test', status: 'passed' }] })
      expect(passed.task.status).toBe('completed')
      expect(git(['rev-parse', 'refs/heads/main']).trim()).toBe(submitted.submission.git?.headSha)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('commits exact bytes, keeps the executable bit and preserves symlinks', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-bytes-')
    try {
      // Nine of these tests used only ASCII text, which is why a corruption of every byte above
      // 0x7f survived three live rounds: the content was read as a latin1 string and handed to
      // stdin, which re-encoded it as UTF-8.
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xd0, 0x9f])
      await writeFile(join(workspace, 'packages', 'a', 'src', 'image.png'), binary)
      await writeFile(join(workspace, 'packages', 'a', 'src', 'run.sh'), '#!/bin/sh\necho hi\n')
      await chmod(join(workspace, 'packages', 'a', 'src', 'run.sh'), 0o755)
      await symlink('one.ts', join(workspace, 'packages', 'a', 'src', 'shortcut.ts'))
      // A file the base had, removed by this work: the commit must record the deletion.
      const created = await store.createTask({ title: 'Bytes', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await rm(join(workspace, 'packages', 'a', 'README.md'))
      // Submitted as a report: the commit is then built from the observed changes, which is the only
      // shape that can express a removal (a file list carries a digest per file).
      await mkdir(join(workspace, '.dsh-live-teams', 'reports'), { recursive: true })
      await writeFile(join(workspace, '.dsh-live-teams', 'reports', 'bytes.md'), 'bytes, mode, link, removal\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: '.dsh-live-teams/reports/bytes.md' }, summary: 'bytes, mode, link and a removal', checks: [] })
      const head = String(submitted.submission.git?.headSha)
      const blob = execFileSync('git', ['-C', workspace, 'cat-file', 'blob', `${head}:packages/a/src/image.png`])
      expect(blob.equals(binary)).toBe(true)
      expect(git(['ls-tree', head, 'packages/a/src/run.sh']).trim().split(/\s+/u)[0]).toBe('100755')
      expect(git(['ls-tree', head, 'packages/a/src/shortcut.ts']).trim().split(/\s+/u)[0]).toBe('120000')
      expect(git(['cat-file', 'blob', `${head}:packages/a/src/shortcut.ts`]).trim()).toBe('one.ts')
      expect(git(['ls-tree', head, 'packages/a/README.md']).trim()).toBe('')
      expect(git(['diff', '--name-status', `${String(submitted.submission.git?.baseTipSha)}..${head}`]).trim().split('\n').sort()).toEqual([
        'A\tpackages/a/src/image.png',
        'A\tpackages/a/src/run.sh',
        'A\tpackages/a/src/shortcut.ts',
        'D\tpackages/a/README.md',
      ].sort())
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('parents on the current base when the movement cannot touch the declared paths (F21)', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-rebase-')
    try {
      const base = await baseInfo(workspace)
      const created = await store.createTask({ title: 'Plural', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 4\n')
      // A sibling lands on the base while this attempt is still working — the live case, where the
      // sibling integrated 1.1 seconds before the submission was frozen.
      await mkdir(join(workspace, 'sibling'), { recursive: true })
      await writeFile(join(workspace, 'sibling', 'other.ts'), 'export const other = 1\n')
      git(['add', 'sibling/other.ts'])
      git(['-c', 'user.email=sibling@check', '-c', 'user.name=sibling', 'commit', '-qm', 'sibling'])
      const movedTip = git(['rev-parse', 'refs/heads/main']).trim()

      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'README-of-the-task.md' }, summary: 'changed one', checks: [] }).catch(async (error: unknown) => {
        // The report body has to exist: write it and retry, so the test exercises the base rule.
        await writeFile(join(workspace, 'README-of-the-task.md'), 'report\n')
        throw error
      }).catch(async () => await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'README-of-the-task.md' }, summary: 'changed one', checks: [] }))
      expect(submitted.submission.git).toMatchObject({ baseTipSha: movedTip, rebasedFrom: base?.sha, commitPaths: ['packages/a/src/one.ts'] })
      expect(git(['rev-parse', `${String(submitted.submission.git?.headSha)}^`]).trim()).toBe(movedTip)
      const passed = await store.reviewTask({ taskId: created.task.id, submissionId: submitted.submission.id, reviewerMemberId: 'reviewer', verdict: 'pass', evidence: [{ command: 'test', status: 'passed' }] })
      expect(passed.task.status).toBe('completed')
      expect(git(['rev-parse', 'refs/heads/main']).trim()).toBe(submitted.submission.git?.headSha)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('refuses to refresh when the movement touches the declared paths (F21)', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-conflict-')
    try {
      const created = await store.createTask({ title: 'Change one', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 5\n')
      // Somebody else commits into the very file this task is editing: refreshing the base here
      // would silently revert their change, so the submission has to be refused instead.
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 99\n')
      git(['add', 'packages/a/src/one.ts'])
      git(['-c', 'user.email=other@check', '-c', 'user.name=other', 'commit', '-qm', 'neighbour'])
      await expect(store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'files', paths: ['packages/a/src/one.ts'] }, summary: 'changed one', checks: [] }))
        .rejects.toThrow(/the base moved since this attempt started/u)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('reconciles an integration interrupted between moving the branch and finishing the task (review finding 1)', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-interrupted-')
    try {
      const created = await store.createTask({ title: 'Interrupted', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 7\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'files', paths: ['packages/a/src/one.ts'] }, summary: 'changed one', checks: [] })
      const git_ = submitted.submission.git
      expect(git_).toBeDefined()

      // The crash: the branch moved, the marker stayed, the task was never completed. Writing the
      // marker by hand is exactly the state a process that died between the two writes leaves behind.
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 7\n')
      git(['update-ref', String(git_?.baseRef), String(git_?.headSha), String(git_?.baseTipSha)])
      const tasksFile = join(workspace, '.dsh-live-teams', 'teams', 'team-1', 'tasks.json')
      const state = JSON.parse(await readFile(tasksFile, 'utf8')) as { tasks: Record<string, unknown>[] }
      state.tasks = state.tasks.map((task) => task.id === created.task.id ? { ...task, integrationPending: { baseRef: git_?.baseRef, headSha: git_?.headSha, baseTipSha: git_?.baseTipSha, at: Date.now() } } : task)
      await writeFile(tasksFile, JSON.stringify(state))

      const reported = await store.reconcilePendingIntegrations({ tipOf: async (ref) => await refTip(workspace, ref), actor: 'reconciler' })
      expect(reported).toEqual([expect.objectContaining({ taskId: created.task.id, state: 'moved' })])
      // Reported once, and the marker stays: finishing the acceptance is a decision, not cleanup.
      expect(await store.reconcilePendingIntegrations({ tipOf: async (ref) => await refTip(workspace, ref), actor: 'reconciler' })).toEqual([])
      expect((await store.readTask(created.task.id)).task.integrationPending).toBeDefined()

      // And the retry works, because integration is idempotent.
      const accepted = await store.acceptTask({ taskId: created.task.id, actor: 'human:desktop' })
      expect(accepted.task.status).toBe('completed')
      expect(accepted.task.integrationPending).toBeUndefined()
      expect(git(['rev-parse', String(git_?.baseRef)]).trim()).toBe(git_?.headSha)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('refuses a submission with an empty change set and names the way out', async () => {
    // The message must say what to do: a member that committed its work has a clean tree, and a
    // report carries no paths. On a real stand a Builder read the plugin's source to find this out.
    const { workspace, store } = await repository('live-teams-b33-empty-')
    try {
      const created = await store.createTask({ title: 'Nothing', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await mkdir(join(workspace, '.dsh-live-teams', 'reports'), { recursive: true })
      await writeFile(join(workspace, '.dsh-live-teams', 'reports', `${created.task.id}.md`), '# report\n')
      await expect(store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: `.dsh-live-teams/reports/${created.task.id}.md` }, summary: 'empty', checks: [] }))
        .rejects.toThrow(/submit it as a file artifact naming those files/u)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('refuses a coding submission that changed nothing under its declaration', async () => {
    const { workspace, store } = await repository('live-teams-b33-empty-')
    try {
      const created = await store.createTask({ title: 'Nothing', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await mkdir(join(workspace, '.dsh-live-teams', 'reports'), { recursive: true })
      await writeFile(join(workspace, '.dsh-live-teams', 'reports', 'empty.md'), 'nothing to report\n')
      await expect(store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: '.dsh-live-teams/reports/empty.md' }, summary: 'nothing', checks: [] }))
        .rejects.toThrow(/nothing changed under the declaration/u)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('advances the base to the reviewed commit when the base has not moved', async () => {
    const { workspace, store, git } = await repository('live-teams-b33-integrate-')
    try {
      const base = await baseInfo(workspace)
      const created = await store.createTask({ title: 'Change one', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead', paths: ['packages/a/**'] })
      await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'packages', 'a', 'src', 'one.ts'), 'export const one = 2\n')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'files', paths: ['packages/a/src/one.ts'] }, summary: 'changed one', checks: [] })
      const frozen = submitted.submission.git
      const accepted = await store.acceptTask({ taskId: created.task.id, actor: 'human:desktop' })
      expect(accepted.task.status).toBe('completed')
      // Integration is the compare-and-swap: the base is now exactly the reviewed commit, and the
      // working tree was never touched to get there.
      expect(git(['rev-parse', 'refs/heads/main']).trim()).toBe(frozen?.headSha)
      expect(git(['log', '--oneline', '-1']).trim()).toContain(frozen?.headSha.slice(0, 7))
      // Tracked files are clean: the index moved with the branch, so a later plain `git commit`
      // cannot silently revert the accepted work. Untracked plugin state is expected.
      expect(git(['status', '--porcelain', '--untracked-files=no']).trim()).toBe('')
      expect(frozen?.baseTipSha).toBe(base?.sha)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
