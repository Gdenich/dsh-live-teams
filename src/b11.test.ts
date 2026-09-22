import { mkdtemp, readFile, rm, stat, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LIVE_TEAMS_TEAM_ADOPT_ROUTE,
  LIVE_TEAMS_TEAM_CANDIDATES_ROUTE,
  LIVE_TEAMS_TEAM_ENABLE_ROUTE,
  registerLiveTeamsRoutes,
  type LiveTeamsRequest,
  type LiveTeamsResponse,
  type LiveTeamsRouteOptions,
  type LiveTeamsWebServer,
} from './routes.js'
import { ERROR_CODES, LiveTeamsError } from './errors.js'
import { TeamStore, type TeamState } from './team-store.js'
import { TaskStore } from './task-store.js'

const headers = { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }

type CapturedResponse = LiveTeamsResponse & { body: string | undefined }
function response(): CapturedResponse {
  let body: string | undefined
  const result = {
    statusCode: 0,
    body,
    setHeader: (_name: string, _value: string) => {},
    end(value?: string) { body = value; result.body = value },
  }
  return result
}

type Handler = (request: LiveTeamsRequest, response: LiveTeamsResponse) => void | Promise<void>
function routes(options: LiveTeamsRouteOptions): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server: LiveTeamsWebServer = { port: 43120, register(route) { handlers.set(route.path, route.handler); return () => {} } }
  registerLiveTeamsRoutes({ webServer: server }, options)
  return handlers
}

function parsed(result: CapturedResponse): Record<string, unknown> { return JSON.parse(result.body ?? '{}') as Record<string, unknown> }

async function makeCandidate(workspacePath: string, teamId = 'b1-team'): Promise<{ store: TeamStore; state: TeamState }> {
  const store = new TeamStore({ workspacePath, workspaceId: 'legacy-workspace', teamId, name: 'B1 Check' })
  await store.open()
  await store.commit(teamId, {
    expectedRevision: 0,
    mutate: (working) => {
      working.members.push({ memberId: 'member-1', displayName: 'Ada', role: 'builder', availability: 'available', sessionId: 'session-1', bindingGeneration: 7, contractRevision: 4, custom: 'kept' })
      working.extra = { keep: true }
    },
  })
  await store.appendEvent(teamId, { kind: 'legacy/audit', detail: 'keep me' })
  return { store, state: await store.open() }
}

async function teamOptions(workspacePath: string, workspaceId: string, teamId: string): Promise<LiveTeamsRouteOptions> {
  const store = new TeamStore({ workspacePath, workspaceId, teamId, name: 'Derived' })
  const status = async () => {
    const state = await store.readExisting()
    if (state === undefined) return { enabled: false, teamId, teamName: 'Derived', workspacePath, memberCount: 0 }
    return { enabled: !(await store.isDisabled(teamId)), teamId, teamName: state.name ?? 'Derived', workspacePath, revision: state.revision, memberCount: state.members.length }
  }
  return {
    teamId, teamName: 'Derived', workspacePath,
    teamStatus: status,
    listTeamCandidates: () => store.listAdoptionCandidates({ workspacePath, derivedTeamId: teamId }),
    adoptTeam: async (candidateTeamId, replaceEmptyDerived) => {
      const result = await store.adoptTeam({ workspacePath, workspaceId, derivedTeamId: teamId, candidateTeamId, replaceEmptyDerived })
      return { status: await status(), adoptedFrom: result.adoptedFrom }
    },
    enableTeam: async (_name, createNew = false) => {
      const state = await store.readExisting()
      const candidates = await store.listAdoptionCandidates({ workspacePath, derivedTeamId: teamId })
      if (state === undefined && candidates.length > 0 && !createNew) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'existing team found', { auditDetail: 'existing team found', details: { candidates } })
      await store.open()
      return status()
    },
  }
}

describe('B11 adoption store', () => {
  it('rewrites identity, preserves members/revisions/audit, moves directory, clears disabled and appends exactly one adoption event', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-adopt-'))
    const { store: candidateStore, state: before } = await makeCandidate(workspace)
    await candidateStore.setDisabled('b1-team', true)
    const beforeEvents = await candidateStore.readEvents('b1-team')
    const target = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-id', teamId: 'derived-id' })
    const result = await target.adoptTeam({ workspacePath: workspace, workspaceId: 'workspace-id', derivedTeamId: 'derived-id', candidateTeamId: 'b1-team', replaceEmptyDerived: false })
    const after = JSON.parse(await readFile(join(workspace, '.dsh-live-teams', 'teams', 'derived-id', 'team.json'), 'utf8')) as TeamState
    expect(after).toEqual({ ...before, teamId: 'derived-id', workspaceId: 'workspace-id', workspacePath: realpathSync.native(workspace) })
    expect(after.members).toEqual(before.members)
    expect(after.revision).toBe(before.revision)
    expect(result.adoptedFrom).toBe('b1-team')
    await expect(stat(join(workspace, '.dsh-live-teams', 'teams', 'b1-team'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(workspace, '.dsh-live-teams', 'teams', 'derived-id', 'disabled'))).rejects.toMatchObject({ code: 'ENOENT' })
    const eventsText = await readFile(join(workspace, '.dsh-live-teams', 'teams', 'derived-id', 'events.jsonl'), 'utf8')
    const events = eventsText.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events.slice(0, beforeEvents.events.length)).toEqual(beforeEvents.events)
    expect(events.filter((event) => event.kind === 'team/adopted')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'team/adopted', teamId: 'derived-id', fromTeamId: 'b1-team', name: 'B1 Check', memberCount: before.members.length, actor: 'human:desktop' })
  })

  it('fences adoption to this teams directory and never lists a foreign workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-fence-'))
    const foreign = await mkdtemp(join(tmpdir(), 'live-teams-b11-foreign-'))
    await makeCandidate(foreign, 'foreign-team')
    const options = await teamOptions(workspace, 'workspace-id', 'derived-id')
    const candidates = await options.listTeamCandidates?.()
    expect(candidates).toEqual([])
    const adopt = routes(options).get(LIVE_TEAMS_TEAM_ADOPT_ROUTE)
    if (adopt === undefined) throw new Error('adopt route missing')
    const result = response()
    await adopt({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 's', teamId: '../outside', replaceEmptyDerived: false }) }, result)
    expect(result.statusCode).toBe(400)
    expect(parsed(result)).toEqual({ error: 'live-teams invalid request' })
  })

  it('rejects a populated derived directory and an empty one without replacement', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-conflicts-'))
    await makeCandidate(workspace, 'legacy-team')
    const populated = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-id', teamId: 'derived-id' })
    await populated.open()
    await populated.commit('derived-id', { expectedRevision: 0, mutate: (state) => { state.members.push({ memberId: 'existing', displayName: 'Existing', role: 'builder', availability: 'available', bindingGeneration: 1, contractRevision: 0 }) } })
    await expect(populated.adoptTeam({ workspacePath: workspace, workspaceId: 'workspace-id', derivedTeamId: 'derived-id', candidateTeamId: 'legacy-team', replaceEmptyDerived: true })).rejects.toMatchObject({ auditDetail: 'derived team already exists' })

    const workspace2 = await mkdtemp(join(tmpdir(), 'live-teams-b11-empty-'))
    await makeCandidate(workspace2, 'legacy-team')
    const empty = new TeamStore({ workspacePath: workspace2, workspaceId: 'workspace-id', teamId: 'derived-id' })
    await empty.open()
    await empty.appendEvent('derived-id', { kind: 'team/enabled' })
    await expect(empty.adoptTeam({ workspacePath: workspace2, workspaceId: 'workspace-id', derivedTeamId: 'derived-id', candidateTeamId: 'legacy-team', replaceEmptyDerived: false })).rejects.toMatchObject({ auditDetail: 'derived team already exists' })
    await expect(stat(join(workspace2, '.dsh-live-teams', 'teams', 'legacy-team'))).resolves.toBeTruthy()
  })

  it('replaces an empty derived directory only when requested and keeps the replaced directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-replace-'))
    await makeCandidate(workspace, 'legacy-team')
    const target = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-id', teamId: 'derived-id' })
    await target.open()
    // Several audit events, not one: a single-event file parses even when the
    // reader forgets to split it into lines, which is exactly how a broken
    // reader passed this test while every real adoption failed.
    await target.appendEvent('derived-id', { kind: 'team/enabled' })
    await target.appendEvent('derived-id', { kind: 'team/disabled' })
    await target.appendEvent('derived-id', { kind: 'team/enabled' })
    await target.adoptTeam({ workspacePath: workspace, workspaceId: 'workspace-id', derivedTeamId: 'derived-id', candidateTeamId: 'legacy-team', replaceEmptyDerived: true })
    const names = await readdir(join(workspace, '.dsh-live-teams', 'teams'))
    expect(names.some((name) => /^derived-id\.\d+\.replaced$/u.test(name))).toBe(true)
    await expect(stat(join(workspace, '.dsh-live-teams', 'teams', 'derived-id', 'team.json'))).resolves.toBeTruthy()
  })

  it('never offers a directory parked beside the derived team', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-parked-'))
    await makeCandidate(workspace, 'real-legacy')
    const teams = join(workspace, '.dsh-live-teams', 'teams')
    // What the plugin leaves behind when it replaces a derived team, plus a
    // directory parked by hand under the same prefix.
    await mkdir(join(teams, 'derived-id.1789330364910.replaced'), { recursive: true })
    await writeFile(join(teams, 'derived-id.1789330364910.replaced', 'team.json'), JSON.stringify({
      schemaVersion: 1, revision: 1, teamId: 'derived-id', workspaceId: 'w', workspacePath: workspace,
      name: 'Parked', createdAt: 1, updatedAt: 1, archivedMemberIds: [], members: [],
    }))
    await mkdir(join(teams, 'derived-id.empty-before-adoption'), { recursive: true })
    await writeFile(join(teams, 'derived-id.empty-before-adoption', 'team.json'), JSON.stringify({
      schemaVersion: 1, revision: 1, teamId: 'derived-id', workspaceId: 'w', workspacePath: workspace,
      name: 'Parked by hand', createdAt: 1, updatedAt: 1, archivedMemberIds: [], members: [],
    }))
    const store = new TeamStore({ workspacePath: workspace, workspaceId: 'derived-id', teamId: 'derived-id' })
    const candidates = await store.listAdoptionCandidates({ workspacePath: workspace, derivedTeamId: 'derived-id' })
    expect(candidates.map((candidate) => candidate.teamId)).toEqual(['real-legacy'])
  })

  it('refuses a candidate whose members the read path could not render', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-unreadable-'))
    const teams = join(workspace, '.dsh-live-teams', 'teams')
    await mkdir(join(teams, 'bad-members'), { recursive: true })
    // `sessionId: null` is what a snapshot shows for an unbound member, but the
    // stored record must omit the field. Adopting this would produce an enabled
    // team whose members cannot be read at all.
    await writeFile(join(teams, 'bad-members', 'team.json'), JSON.stringify({
      schemaVersion: 1, revision: 3, teamId: 'bad-members', workspaceId: 'old', workspacePath: workspace,
      name: 'Unreadable', createdAt: 1, updatedAt: 1, archivedMemberIds: [],
      members: [{ memberId: 'm-1', displayName: 'Ghost', role: 'builder', availability: 'available', sessionId: null, bindingGeneration: 1, contractRevision: 0 }],
    }))
    const store = new TeamStore({ workspacePath: workspace, workspaceId: 'derived-id', teamId: 'derived-id' })
    const candidates = await store.listAdoptionCandidates({ workspacePath: workspace, derivedTeamId: 'derived-id' })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ teamId: 'bad-members', usable: false })
    // The candidate is rejected by the same validation the reader uses, so it can
    // never be adopted into an unreadable team.
    await expect(store.adoptTeam({ workspacePath: workspace, workspaceId: 'derived-id', derivedTeamId: 'derived-id', candidateTeamId: 'bad-members', replaceEmptyDerived: false }))
      .rejects.toMatchObject({ code: 'STATE_CORRUPT' })
  })

  it('reports corrupt candidates as unusable and continues scanning', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-corrupt-'))
    const teams = join(workspace, '.dsh-live-teams', 'teams')
    await mkdir(join(teams, 'broken'), { recursive: true })
    await writeFile(join(teams, 'broken', 'team.json'), '{not json')
    await makeCandidate(workspace, 'usable-team')
    const store = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-id', teamId: 'derived-id' })
    const candidates = await store.listAdoptionCandidates({ workspacePath: workspace, derivedTeamId: 'derived-id' })
    expect(candidates).toEqual([
      expect.objectContaining({ teamId: 'usable-team', memberCount: 1 }),
      { teamId: 'broken', usable: false, reason: 'invalid state' },
    ])
  })

  /**
   * Adoption renames the directory, so every file that repeats the team id must
   * be re-stamped with the new one. Re-stamping only `team.json` left the Tasks
   * and Messages panels answering `503 live-teams state unavailable` on every
   * read, because each store validates the id inside its own files.
   */
  it('re-stamps the team id in every state file it moves, so the readers still accept them', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-restamp-'))
    await makeCandidate(workspace, 'legacy-team')
    const candidate = join(workspace, '.dsh-live-teams', 'teams', 'legacy-team')
    // The shape the sibling stores write: the id at the top level and inside records.
    await writeFile(join(candidate, 'tasks.json'), JSON.stringify({
      schemaVersion: 1, revision: 1, teamId: 'legacy-team',
      tasks: [{
        id: 'task-1', teamId: 'legacy-team', title: 'Live task check', kind: 'implementation', status: 'ready',
        assignee: 'member-1', route: { type: 'review', reviewer: 'member-1' }, acceptance: ['the checks pass'],
        roundLimit: 5, createdBy: 'member-1', createdAt: 1, updatedAt: 1, revision: 1,
      }],
    }))
    await writeFile(join(candidate, 'messages.json'), JSON.stringify({
      schemaVersion: 1, revision: 1, teamId: 'legacy-team',
      messages: [{ id: 'msg-1', teamId: 'legacy-team', kind: 'message', content: 'hello' }],
    }))

    const store = new TeamStore({ workspacePath: workspace, workspaceId: 'derived-id', teamId: 'derived-id' })
    await store.adoptTeam({ workspacePath: workspace, workspaceId: 'derived-id', derivedTeamId: 'derived-id', candidateTeamId: 'legacy-team', replaceEmptyDerived: false })

    const directory = join(workspace, '.dsh-live-teams', 'teams', 'derived-id')
    const tasks = JSON.parse(await readFile(join(directory, 'tasks.json'), 'utf8')) as { teamId: string; tasks: Array<{ teamId: string }> }
    expect(tasks.teamId).toBe('derived-id')
    expect(tasks.tasks[0]?.teamId).toBe('derived-id')
    const messages = JSON.parse(await readFile(join(directory, 'messages.json'), 'utf8')) as { teamId: string; messages: Array<{ teamId: string }> }
    expect(messages.teamId).toBe('derived-id')
    expect(messages.messages[0]?.teamId).toBe('derived-id')
    // The reader that refused this state in the live stand answers 503; it must accept it now.
    await expect(new TaskStore({ workspacePath: workspace, teamId: 'derived-id' }).listTasks()).resolves.toHaveLength(1)
  })

  it('refuses an adoption whose sibling state cannot be read, and leaves it where it was', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-restamp-bad-'))
    await makeCandidate(workspace, 'legacy-team')
    const candidate = join(workspace, '.dsh-live-teams', 'teams', 'legacy-team')
    await writeFile(join(candidate, 'tasks.json'), '{not json')

    const store = new TeamStore({ workspacePath: workspace, workspaceId: 'derived-id', teamId: 'derived-id' })
    await expect(store.adoptTeam({ workspacePath: workspace, workspaceId: 'derived-id', derivedTeamId: 'derived-id', candidateTeamId: 'legacy-team', replaceEmptyDerived: false }))
      .rejects.toMatchObject({ code: ERROR_CODES.STATE_CORRUPT })

    // Nothing was written and nothing moved, so a retry starts from the same state.
    const team = JSON.parse(await readFile(join(candidate, 'team.json'), 'utf8')) as { teamId: string }
    expect(team.teamId).toBe('legacy-team')
    await expect(stat(join(workspace, '.dsh-live-teams', 'teams', 'derived-id'))).rejects.toThrow()
  })
})

describe('F16 automatic adoption by path', () => {
  it('adopts the only team that belongs to this path under another id, and audits it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-f16-'))
    try {
      await makeCandidate(workspace, 'legacy-id')
      const target = new TeamStore({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })
      const adopted = await target.adoptByPath({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id', actor: 'plugin' })
      expect(adopted).toMatchObject({ adoptedFrom: 'legacy-id', memberCount: 1 })
      const state = await target.open()
      expect(state.teamId).toBe('fresh-id')
      expect(state.workspaceId).toBe('fresh-id')
      expect(state.members).toHaveLength(1)
      // The audit says a plugin did it, not a human: the two are different facts.
      const events = (await target.readEvents('fresh-id')).events
      const adoption = events.find((event) => (event as { kind?: string }).kind === 'team/adopted') as { actor?: string; fromTeamId?: string } | undefined
      expect(adoption?.actor).toBe('plugin')
      expect(adoption?.fromTeamId).toBe('legacy-id')
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('re-points state paths that live inside the moved team directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-f16-paths-'))
    try {
      await makeCandidate(workspace, 'legacy-id')
      const legacy = new TeamStore({ workspacePath: workspace, workspaceId: 'legacy-workspace', teamId: 'legacy-id' })
      // An accepted task records the absolute path of its archived document; adopting the
      // team moves that directory, and a stale path makes the whole task record invalid.
      const archiveDirectory = join(workspace, '.dsh-live-teams', 'teams', 'legacy-id', 'archive')
      await mkdir(archiveDirectory, { recursive: true })
      const archivedPath = join(archiveDirectory, '1-task-legacy.md')
      await writeFile(archivedPath, '# archived\n')
      const tasksFile = join(workspace, '.dsh-live-teams', 'teams', 'legacy-id', 'tasks.json')
      await writeFile(tasksFile, JSON.stringify({
        schemaVersion: 1, revision: 1, teamId: 'legacy-id',
        tasks: [{ id: 'task-legacy', teamId: 'legacy-id', title: 'Done', kind: 'implementation', status: 'completed', acceptance: ['ok'], createdBy: 'lead', createdAt: 1, updatedAt: 1, revision: 1, archivedPath }],
      }))
      const target = new TeamStore({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })
      expect(await target.adoptByPath({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })).toMatchObject({ adoptedFrom: 'legacy-id' })
      const moved = JSON.parse(await readFile(join(workspace, '.dsh-live-teams', 'teams', 'fresh-id', 'tasks.json'), 'utf8')) as { tasks: { teamId: string; archivedPath: string }[] }
      expect(moved.tasks[0]?.teamId).toBe('fresh-id')
      expect(moved.tasks[0]?.archivedPath).toContain(`teams${sep}fresh-id${sep}archive`)
      expect(moved.tasks[0]?.archivedPath).not.toContain(`teams${sep}legacy-id${sep}`)
      await expect(stat(moved.tasks[0]?.archivedPath as string)).resolves.toBeDefined()
      void legacy
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('leaves an ambiguous set to the human', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-f16-two-'))
    try {
      await makeCandidate(workspace, 'legacy-one')
      await makeCandidate(workspace, 'legacy-two')
      const target = new TeamStore({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })
      expect(await target.adoptByPath({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })).toBeUndefined()
      expect(await target.readExisting()).toBeUndefined()
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('does not move an empty team, and never overwrites a live one', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-f16-live-'))
    try {
      // An empty candidate is not worth moving.
      const empty = new TeamStore({ workspacePath: workspace, workspaceId: 'legacy-workspace', teamId: 'empty-legacy' })
      await empty.open()
      const target = new TeamStore({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })
      expect(await target.adoptByPath({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })).toBeUndefined()

      // And a team of our own with members wins over an older candidate.
      await target.open()
      await target.commit('fresh-id', { expectedRevision: 0, mutate: (state) => { state.members.push({ memberId: 'mine', displayName: 'Mine', role: 'builder', availability: 'available', sessionId: 'session-mine', bindingGeneration: 1, contractRevision: 1 }) } })
      await makeCandidate(workspace, 'legacy-with-members')
      expect(await target.adoptByPath({ workspacePath: workspace, workspaceId: 'fresh-id', teamId: 'fresh-id' })).toBeUndefined()
      expect((await target.open()).members.map((member) => member.memberId)).toEqual(['mine'])
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})

describe('B11 lifecycle routes', () => {
  it('lists and adopts candidates, and enable without createNew returns 409 without creating state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-routes-'))
    await makeCandidate(workspace, 'legacy-team')
    const options = await teamOptions(workspace, 'workspace-id', 'derived-id')
    const handlers = routes(options)
    const listed = response()
    await handlers.get(LIVE_TEAMS_TEAM_CANDIDATES_ROUTE)?.({ method: 'GET', url: '/api/live-teams/team/candidates?session=s', headers, socket: { remoteAddress: '127.0.0.1' } }, listed)
    expect(listed.statusCode).toBe(200)
    expect(parsed(listed).candidates).toEqual([expect.objectContaining({ teamId: 'legacy-team', memberCount: 1 })])

    const enabled = response()
    await handlers.get(LIVE_TEAMS_TEAM_ENABLE_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 's' }) }, enabled)
    expect(enabled.statusCode).toBe(409)
    expect(parsed(enabled)).toMatchObject({ error: 'live-teams existing team found' })
    await expect(stat(join(workspace, '.dsh-live-teams', 'teams', 'derived-id'))).rejects.toMatchObject({ code: 'ENOENT' })

    const adopted = response()
    await handlers.get(LIVE_TEAMS_TEAM_ADOPT_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 's', teamId: 'legacy-team', replaceEmptyDerived: false }) }, adopted)
    expect(adopted.statusCode).toBe(200)
    expect(parsed(adopted)).toMatchObject({ teamId: 'derived-id', adoptedFrom: 'legacy-team', memberCount: 1 })
  })

  it('enable with createNew explicitly creates the derived team despite candidates', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-create-'))
    await makeCandidate(workspace, 'legacy-team')
    const options = await teamOptions(workspace, 'workspace-id', 'derived-id')
    const result = response()
    await routes(options).get(LIVE_TEAMS_TEAM_ENABLE_ROUTE)?.({ method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' }, body: JSON.stringify({ sessionId: 's', createNew: true }) }, result)
    expect(result.statusCode).toBe(200)
    expect(parsed(result)).toMatchObject({ enabled: true, teamId: 'derived-id', memberCount: 0 })
  })
})


describe('reserved actor names (impersonation)', () => {
  it('refuses to persist a member whose id is one of the transport actors', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b11-reserved-'))
    try {
      const store = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      await store.open()
      const opened = await store.open()
      // A member called `human` would send mail as the human: the mailbox trusts that name, so the
      // store refuses to write it at all — a check on the HTTP boundary would protect one door only.
      await expect(store.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { state.members.push({ memberId: 'human', displayName: 'Impostor', role: 'builder', availability: 'available', bindingGeneration: 1, contractRevision: 0 } as never) } }))
        .rejects.toThrow(/reserved actor name/u)
      await expect(store.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { state.members.push({ memberId: 'Scheduler', displayName: 'Impostor', role: 'builder', availability: 'available', bindingGeneration: 1, contractRevision: 0 } as never) } }))
        .rejects.toThrow(/reserved actor name/u)
      // An ordinary member still goes through.
      const ok = await store.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { state.members.push({ memberId: 'm-worker', displayName: 'Worker', role: 'builder', availability: 'available', bindingGeneration: 1, contractRevision: 0 } as never) } })
      expect(ok.state.members).toHaveLength(1)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
