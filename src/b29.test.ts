import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { registerMemberTools, type MemberToolsBinding } from './member-tools.js'
import { assignmentThread, createDispatcher, evaluateTask, projectDispatch, type Dispatcher } from './dispatch.js'
import { createMailbox, NO_SESSION_FAILURE, type CommandQueueLike, type MailboxRecipient, type MailboxService } from './mailbox.js'
import { blockedBy, createTaskStore, type TaskStore, type TeamTask } from './task-store.js'
import { readDispatchSwitch, TeamStore, type MemberRecord, type TeamState } from './team-store.js'

type TestCommand = {
  commandId: string
  idempotencyKey: string
  sessionId: string
  bindingGeneration: number
  mode: 'queue' | 'steer'
  requestId: string
  state: 'pending' | 'leased' | 'admitted' | 'applied' | 'failed'
  receipt: string | undefined
  failureCode: string | undefined
  failureDetail: string | undefined
  revision: number
}

function queue(options: { failFirstAdmit?: boolean } = {}): { queue: CommandQueueLike; admittances: TestCommand[]; texts: string[] } {
  const admittances: TestCommand[] = []
  const texts: string[] = []
  const keys = new Map<string, TestCommand>()
  let failed = false
  return {
    admittances,
    texts,
    queue: {
      admit: async (request) => {
        if (options.failFirstAdmit === true && !failed) { failed = true; throw new Error('transport is down') }
        const existing = keys.get(request.idempotencyKey)
        if (existing !== undefined) return { record: existing, duplicate: true }
        texts.push((request.content[0] as { text?: string } | undefined)?.text ?? '')
        const record: TestCommand = {
          commandId: `command-${String(admittances.length + 1)}`, idempotencyKey: request.idempotencyKey, sessionId: request.sessionId,
          bindingGeneration: request.bindingGeneration, mode: request.mode, requestId: `team-1:${request.idempotencyKey}`,
          state: 'admitted', receipt: 'accepted', failureCode: undefined, failureDetail: undefined, revision: 1,
        }
        keys.set(request.idempotencyKey, record)
        admittances.push(record)
        return { record, duplicate: false }
      },
      dispatch: async (commandId) => {
        const record = admittances.find((candidate) => candidate.commandId === commandId)
        if (record === undefined) throw new Error('missing test command')
        return record
      },
    },
  }
}

function member(memberId: string, displayName: string, role: string, sessionId?: string): MemberRecord {
  return { memberId, displayName, role, availability: 'available', ...(sessionId === undefined ? {} : { sessionId }), bindingGeneration: 1, contractRevision: 0 }
}
function teamState(members: MemberRecord[], overrides: Partial<TeamState> = {}): TeamState {
  return {
    schemaVersion: 1, revision: 1, teamId: 'team-1', workspaceId: 'workspace-1', workspacePath: '/tmp',
    members, archivedMemberIds: [], createdAt: 1, updatedAt: 1, leadMemberId: 'lead', ...overrides,
  } as TeamState
}
function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1', teamId: 'team-1', title: 'Implement the thing', kind: 'implementation', status: 'ready',
    assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['tests pass'], roundLimit: 5,
    createdBy: 'lead', createdAt: 1, updatedAt: 1, revision: 1, ...overrides,
  } as TeamTask
}

type Fixture = {
  workspace: string
  store: TeamStore
  taskStore: TaskStore
  mailbox: MailboxService
  dispatcher: Dispatcher
  audit: { kind?: string }[]
  admittances: TestCommand[]
  texts: string[]
  recipients: MailboxRecipient[]
  setRecipients: (members: readonly MemberRecord[]) => void
  cleanup: () => Promise<void>
}
async function fixture(options: { quiesce?: boolean; members?: MemberRecord[]; failFirstAdmit?: boolean; settleTaskOnClaim?: boolean; now?: () => number; stalledAfterMs?: number; sessionStatus?: (sessionId: string) => Promise<'running' | 'idle' | 'unknown'> } = {}): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b29-'))
  const store = new TeamStore({ workspacePath: workspace, workspaceId: 'workspace-1', teamId: 'team-1' })
  await store.open()
  const opened = await store.open()
  const members = options.members ?? [member('lead', 'Lead', 'lead', 's-lead'), member('worker', 'Builder', 'engineer', 's-worker'), member('reviewer', 'Tester', 'verifier', 's-reviewer')]
  await store.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => { Object.assign(state, teamState(members)) } })
  const audit: { kind?: string }[] = []
  const taskStore = createTaskStore({
    workspacePath: workspace, teamId: 'team-1', appendAudit: async (event) => { audit.push(event as { kind?: string }) },
    interruptSession: async () => undefined,
    awaitQuiescence: async () => options.quiesce !== false,
  })
  const { queue: commandQueue, admittances, texts } = queue({ ...(options.failFirstAdmit === true ? { failFirstAdmit: true } : {}) })
  const asRecipients = (list: readonly MemberRecord[]): MailboxRecipient[] => list.map((entry) => ({ memberId: entry.memberId, displayName: entry.displayName, ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }), bindingGeneration: entry.bindingGeneration, active: true }))
  let recipients: MailboxRecipient[] = asRecipients(members)
  const mailbox = createMailbox({
    workspacePath: workspace, teamId: 'team-1', queue: commandQueue,
    listRecipients: async () => recipients,
    resolveSessionSender: async () => undefined,
    appendAudit: async (event) => { audit.push(event as { kind?: string }) },
  })
  // F22: a pass reads its view once at the start, so a task can settle while the pass is running.
  // The seam settles the task at the moment the dispatcher claims it — which is what a concurrent
  // human acceptance looks like from inside the pass — and is independent of how many times the pass
  // reads the list (an earlier version counted reads, and adding the stalled detector broke it).
  const settleOnClaim = options.settleTaskOnClaim === true
  const settle = async (taskId: string): Promise<void> => {
    const tasksFile = join(workspace, '.dsh-live-teams', 'teams', 'team-1', 'tasks.json')
    const state = JSON.parse(await readFile(tasksFile, 'utf8')) as { tasks: { id: string; status: string }[] }
    state.tasks = state.tasks.map((entry) => entry.id === taskId ? { ...entry, status: 'completed' } : entry)
    await writeFile(tasksFile, JSON.stringify(state))
  }
  const dispatcherTaskStore: Pick<TaskStore, 'listTasks' | 'readAttempts' | 'claimTask' | 'markHumanIntervention' | 'closeTerminalAttempts' | 'pruneSnapshots' | 'markAttemptStalled' | 'reconcilePendingIntegrations'> = {
    listTasks: async (...args) => await taskStore.listTasks(...args),
    readAttempts: async () => await taskStore.readAttempts(),
    claimTask: async (request) => {
      const claimed = await taskStore.claimTask(request)
      if (settleOnClaim) await settle(request.taskId)
      return claimed
    },
    markHumanIntervention: async (attemptId, at) => await taskStore.markHumanIntervention(attemptId, at),
    closeTerminalAttempts: async () => await taskStore.closeTerminalAttempts(),
    pruneSnapshots: async () => await taskStore.pruneSnapshots(),
    markAttemptStalled: async (request) => await taskStore.markAttemptStalled(request),
    reconcilePendingIntegrations: async (request) => await taskStore.reconcilePendingIntegrations(request),
  }
  const dispatcher = createDispatcher({
    workspacePath: workspace, teamId: 'team-1',
    readTeam: async () => await store.open(),
    taskStore: dispatcherTaskStore,
    mailbox,
    appendAudit: async (event) => { audit.push(event as { kind?: string }); await store.appendEvent('team-1', event) },
    // These tests exercise the reconciler; the coding policy they would otherwise trip
    // over has its own test below and its own default.
    codingDispatch: 'automatic',
    sweepIntervalMs: 3_600_000,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sessionStatus === undefined ? {} : { sessionStatus: options.sessionStatus }),
    ...(options.stalledAfterMs === undefined ? {} : { stalledAfterMs: options.stalledAfterMs }),
  })
  return {
    workspace, store, taskStore, mailbox, dispatcher, audit, admittances, texts,
    get recipients() { return recipients },
    setRecipients: (next) => { recipients = asRecipients(next) },
    cleanup: async () => { await dispatcher.stop(); await rm(workspace, { recursive: true, force: true }) },
  }
}

const kinds = (audit: readonly { kind?: string }[]): string[] => audit.map((event) => event.kind ?? '')

describe('B29 dispatch gate', () => {
  const members = [member('lead', 'Lead', 'lead', 's-lead'), member('worker', 'Builder', 'engineer', 's-worker'), member('reviewer', 'Tester', 'verifier', 's-reviewer')]
  const team = teamState(members)
  const memberOf = (memberId: string): MemberRecord | undefined => team.members.find((entry) => entry.memberId === memberId)
  const evaluate = (value: TeamTask, overrides: { tasks?: TeamTask[]; attempts?: never[] | { id: string; taskId: string; memberId: string; status: 'active' | 'revoking' }[]; paused?: boolean; workers?: MemberRecord[]; coding?: 'manual' | 'automatic' } = {}) => evaluateTask({
    task: value, tasks: overrides.tasks ?? [value], attempts: (overrides.attempts ?? []) as never, team: overrides.workers === undefined ? team : teamState(overrides.workers),
    paused: overrides.paused === true, coding: overrides.coding ?? 'automatic', memberOf,
  })

  it('starts a ready, unblocked task for an available member', () => {
    const value = evaluate(task())
    expect(value).toMatchObject({ decision: 'assign', reason: 'ok' })
    expect(value.detail).toContain('Builder')
  })

  it('names the blocking task instead of starting blocked work', () => {
    const dependency = task({ id: 'task-0', title: 'First', status: 'in_progress', assignee: 'reviewer' })
    const dependent = task({ id: 'task-1', dependsOn: ['task-0'] })
    const value = evaluate(dependent, { tasks: [dependency, dependent] })
    expect(value).toMatchObject({ decision: 'wait', reason: 'dependency-open' })
    expect(value.detail).toBe('blocked by task-0 "First" (in_progress)')
    expect(blockedBy(dependent, [dependency, dependent])).toHaveLength(1)
    // The same task with the dependency completed is admissible.
    expect(evaluate(dependent, { tasks: [{ ...dependency, status: 'completed' }, dependent] })).toMatchObject({ decision: 'assign', reason: 'ok' })
  })

  it('reports the states that need a person as what they are', () => {
    expect(evaluate(task({ status: 'waiting' }))).toMatchObject({ decision: 'wait', reason: 'human-gate' })
    expect(evaluate(task({ status: 'needs_human' }))).toMatchObject({ decision: 'wait', reason: 'human-gate' })
    expect(evaluate(task({ status: 'draft' }))).toMatchObject({ decision: 'refused', reason: 'task-not-ready' })
    expect(evaluate(task({ status: 'completed' }))).toMatchObject({ decision: 'refused', reason: 'task-not-ready' })
  })

  it('reports a revoking attempt before the generic not-ready state', () => {
    const stuck = task({ status: 'needs_human', activeAttemptId: 'attempt-1' })
    const attempts = [{ id: 'attempt-1', taskId: 'task-1', memberId: 'worker', status: 'revoking' as const }]
    // The state that needs a person is named first: nothing may start beside it.
    expect(evaluate(stuck, { attempts })).toMatchObject({ decision: 'wait', reason: 'attempt-revoking' })
    // A running attempt on a normal task is reported as who holds it, not as "not ready".
    const running = task({ status: 'in_progress', activeAttemptId: 'attempt-1' })
    expect(evaluate(running, { attempts: [{ ...attempts[0]!, status: 'active' }] })).toMatchObject({ decision: 'active', reason: 'attempt-active' })
    // And a task waiting for a human stays a human gate even while its attempt runs.
    expect(evaluate(stuck, { attempts: [{ ...attempts[0]!, status: 'active' }] })).toMatchObject({ decision: 'wait', reason: 'human-gate' })
  })

  it('refuses a departed owner and a member with no Session', () => {
    expect(evaluate(task({ assignee: 'ghost' }))).toMatchObject({ decision: 'refused', reason: 'member-unknown' })
    const withoutSession = [member('lead', 'Lead', 'lead', 's-lead'), member('worker', 'Builder', 'engineer')]
    expect(evaluateTask({ task: task(), tasks: [task()], attempts: [], team: teamState(withoutSession), paused: false, coding: 'automatic', memberOf: (id) => withoutSession.find((entry) => entry.memberId === id) })).toMatchObject({ decision: 'wait', reason: 'no-session' })
  })

  it('never starts coding work on its own while the deployment has no isolation', () => {
    // Design §22: until Gate C passes, research and documentation may be dispatched and
    // coding is supervised by a human. A generic `work` is read as code: an unknown kind
    // must not be the way around the rule.
    for (const kind of ['implementation', 'repair', 'integration', 'work'] as const) {
      const value = evaluate(task({ kind }), { coding: 'manual' })
      expect(value).toMatchObject({ decision: 'wait', reason: 'coding-not-isolated' })
      expect(value.detail).toContain('codingDispatch: automatic')
      expect(evaluate(task({ kind }), { coding: 'automatic' })).toMatchObject({ decision: 'assign', reason: 'ok' })
    }
    for (const kind of ['research', 'requirements', 'verification', 'review'] as const) {
      expect(evaluate(task({ kind }), { coding: 'manual' })).toMatchObject({ decision: 'assign', reason: 'ok' })
    }
    // The task's own state and its dependencies are named first: a policy is not news
    // while something more concrete is in the way.
    const dependency = task({ id: 'task-0', title: 'First', status: 'in_progress', assignee: 'reviewer' })
    const dependent = task({ id: 'task-1', kind: 'implementation', dependsOn: ['task-0'] })
    expect(evaluate(dependent, { tasks: [dependency, dependent], coding: 'manual' })).toMatchObject({ reason: 'dependency-open' })
    expect(evaluate(task({ kind: 'implementation', status: 'completed' }), { coding: 'manual' })).toMatchObject({ reason: 'task-not-ready' })
  })

  it('respects a paused member and a busy member', () => {
    const paused = [member('lead', 'Lead', 'lead', 's-lead'), { ...member('worker', 'Builder', 'engineer', 's-worker'), availability: 'paused' }]
    expect(evaluateTask({ task: task(), tasks: [task()], attempts: [], team: teamState(paused), paused: false, coding: 'automatic', memberOf: (id) => paused.find((entry) => entry.memberId === id) })).toMatchObject({ decision: 'wait', reason: 'member-paused' })
    const busy = [{ id: 'attempt-9', taskId: 'task-9', memberId: 'worker', status: 'active' as const }]
    const value = evaluate(task(), { attempts: busy })
    expect(value).toMatchObject({ decision: 'wait', reason: 'member-busy' })
    expect(value.detail).toContain('task-9')
  })

  it('pauses the whole team without touching a running attempt', () => {
    const running = task({ status: 'in_progress', activeAttemptId: 'attempt-1' })
    const value = evaluate(running, { paused: true, attempts: [{ id: 'attempt-1', taskId: 'task-1', memberId: 'worker', status: 'active' }] })
    expect(value).toMatchObject({ decision: 'wait', reason: 'dispatch-paused' })
  })

  it('warns about a capability mismatch without refusing it', () => {
    const value = evaluateTask({
      task: task({ kind: 'research' }), tasks: [task({ kind: 'research' })], attempts: [], team, paused: false, coding: 'automatic',
      memberOf, preferredKindsOf: (memberId) => memberId === 'worker' ? ['implementation'] : [],
    })
    expect(value).toMatchObject({ decision: 'assign', reason: 'ok' })
    expect(value.warning).toContain('implementation')
    // A mismatch never blocks: the lead named the member.
    const projection = projectDispatch({ tasks: [task({ kind: 'research' })], attempts: [], team, memberOf, preferredKindsOf: () => ['implementation'], dispatch: { mode: 'auto', coding: 'automatic' } })
    expect(projection.counts.assign).toBe(1)
    // An automatic team must not report who paused it: the live stand showed
    // `pausedBy: "default"` on a team that was never paused.
    expect(projection.paused).toBe(false)
    expect(projection.pausedBy).toBeUndefined()
  })
})

describe('B29 dispatch switch', () => {
  it('records who paused it and refuses a request that changes nothing', async () => {
    const value = await fixture()
    try {
      const current = await value.store.open()
      const paused = await value.store.setDispatchMode('team-1', 'paused', { actor: 'human:desktop', reason: 'stand maintenance' }, current.revision)
      expect(paused).toMatchObject({ from: 'auto', to: 'paused' })
      expect(readDispatchSwitch(paused.state)).toMatchObject({ mode: 'paused', by: 'human:desktop', reason: 'stand maintenance' })
      await expect(value.store.setDispatchMode('team-1', 'paused', { actor: 'human:desktop' }, paused.state.revision)).rejects.toThrow(/already paused/u)
      await expect(value.store.setDispatchMode('team-1', 'resume' as never, { actor: 'human:desktop' }, paused.state.revision)).rejects.toThrow(/unknown dispatch mode/u)
    } finally { await value.cleanup() }
  })

  it('reads an absent switch as automatic and malformed state as corrupt', async () => {
    expect(readDispatchSwitch(teamState([]))).toMatchObject({ mode: 'auto' })
    expect(() => readDispatchSwitch(teamState([], { dispatch: { mode: 'sometimes' } as never }))).toThrow(/dispatch mode is invalid/u)
    expect(() => readDispatchSwitch(teamState([], { dispatch: { mode: 'paused', by: '', at: 1 } as never }))).toThrow(/dispatch actor is invalid/u)
  })
})

describe('B29 scheduler attribution', () => {
  it('never labels scheduler traffic as peer collaboration', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-b29-mail-'))
    try {
      const { queue: commandQueue, texts } = queue()
      const mailbox = createMailbox({
        workspacePath: workspace, teamId: 'team-1', queue: commandQueue,
        listRecipients: async () => [{ memberId: 'worker', displayName: 'Builder', sessionId: 's-worker', bindingGeneration: 1, active: true }],
        resolveSessionSender: async (sessionId) => sessionId === 's-worker' ? 'worker' : undefined,
      })
      await mailbox.sendFromScheduler({ to: 'worker', kind: 'message', content: 'start it' })
      await mailbox.sendFromSession('s-worker', { to: 'worker', kind: 'message', content: 'peer words' })
      await mailbox.sendFromHuman({ to: 'worker', kind: 'message', content: 'human words' })
      expect(texts).toEqual([
        'Scheduler notification (message): start it',
        'Peer message from Builder (message): peer words',
        'Human instruction (message): human words',
      ])
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})

function execution(sessionId: string): ToolRunContext { return { agent: { session: { id: sessionId } } } as unknown as ToolRunContext }

describe('B29 dispatch tool', () => {
  const current = teamState([member('lead', 'Lead', 'lead', 's-lead'), member('worker', 'Builder', 'engineer', 's-worker')])
  function toolset(flag: boolean, calls: { mode: string; actor: string }[]): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    const binding = (sessionId: string): MemberToolsBinding => ({
      mailbox: {} as never, teamId: 'team-1', teamName: 'Team', member: current.members.find((entry) => entry.sessionId === sessionId)!,
      team: current, live: () => true,
      setDispatch: async (request) => { calls.push({ mode: request.mode, actor: request.actor }); return { from: 'auto', to: request.mode } },
    })
    registerMemberTools({ register: (tool) => { tools.push(tool); return undefined } }, async (sessionId) => binding(sessionId), { includeDispatch: flag })
    return tools
  }

  it('registers only behind its own flag, and only the lead may flip it', async () => {
    expect(toolset(false, []).map((tool) => tool.name)).toEqual(['live_team_send', 'live_team_ack_message', 'live_team_context', 'live_team_status'])
    const calls: { mode: string; actor: string }[] = []
    const tools = toolset(true, calls)
    expect(tools.map((tool) => tool.name)).toContain('live_team_dispatch')
    const dispatch = tools.find((tool) => tool.name === 'live_team_dispatch')!
    await expect(dispatch.execute({ mode: 'paused' }, execution('s-worker'))).rejects.toThrow(/only the lead/u)
    expect(calls).toHaveLength(0)
    await dispatch.execute({ mode: 'paused', reason: 'stand maintenance' }, execution('s-lead'))
    expect(calls).toEqual([{ mode: 'paused', actor: 'lead' }])
  })
})

describe('B29 dispatcher', () => {
  async function readyTask(value: Fixture, overrides: Record<string, unknown> = {}): Promise<TeamTask> {
    const created = await value.taskStore.createTask({ title: 'Implement the thing', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['tests pass'], actor: 'lead', ...overrides } as never)
    return created.task
  }

  it('starts an assigned task exactly once across passes', async () => {
    const value = await fixture()
    try {
      const created = await readyTask(value)
      const first = await value.dispatcher.reconcile('test')
      expect(first.started).toHaveLength(1)
      expect(first.started[0]).toMatchObject({ taskId: created.id, memberId: 'worker' })
      const attempts = (await value.taskStore.readAttempts()).attempts
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ memberId: 'worker', status: 'active', generation: 1 })
      const messages = await value.mailbox.listMessages()
      expect(messages).toHaveLength(1)
      expect(messages[0]?.threadId).toBe(assignmentThread(created.id, attempts[0]!.id))
      expect(messages[0]?.from).toBe('scheduler')
      expect(kinds(value.audit).filter((kind) => kind === 'dispatch/assigned')).toHaveLength(1)

      // A second pass finds a running attempt and starts nothing: one attempt, one
      // message, one admission, one audit entry.
      const second = await value.dispatcher.reconcile('test')
      expect(second.started).toHaveLength(0)
      expect(second.skipped.find((entry) => entry.taskId === created.id)?.reason).toBe('attempt-active')
      expect((await value.taskStore.readAttempts()).attempts).toHaveLength(1)
      expect(await value.mailbox.listMessages()).toHaveLength(1)
      expect(value.admittances).toHaveLength(1)
      expect(kinds(value.audit).filter((kind) => kind === 'dispatch/assigned')).toHaveLength(1)
      expect(kinds(value.audit)).not.toContain('dispatch/blocked')
      expect((await value.taskStore.listTasks())[0]).toMatchObject({ status: 'claimed' })
    } finally { await value.cleanup() }
  })

  it('shows an assignment nobody acknowledged, once, and never revokes it (F3)', async () => {
    let clock = Date.now()
    const value = await fixture({ stalledAfterMs: 60_000, now: () => clock, sessionStatus: async () => 'running' })
    try {
      const task = await value.taskStore.createTask({ title: 'Never picked up', kind: 'research', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['notes'], actor: 'lead' })
      await value.dispatcher.reconcile('start')
      clock += 10 * 60 * 1000
      const first = await value.dispatcher.reconcile('aged')
      expect(first.stalled).toEqual([expect.objectContaining({ taskId: task.task.id, reason: 'unacknowledged' })])
      expect(value.audit.filter((entry) => entry.kind === 'attempt/stalled')).toHaveLength(1)
      // The same silence is not recorded again on the next pass, and nothing was taken away.
      const second = await value.dispatcher.reconcile('aged again')
      expect(second.stalled).toEqual([])
      expect(value.audit.filter((entry) => entry.kind === 'attempt/stalled')).toHaveLength(1)
      const after = (await value.taskStore.readTask(task.task.id)).task
      expect(after.status).toBe('claimed')
      expect((await value.taskStore.readAttempts()).attempts[0]?.status).toBe('active')
    } finally { await value.cleanup() }
  })

  it('shows an acknowledged attempt whose Session went idle without a submission, and leaves a submitted one alone (F3)', async () => {
    let clock = Date.now()
    const value = await fixture({ stalledAfterMs: 60_000, now: () => clock, sessionStatus: async () => 'idle' })
    try {
      const task = await value.taskStore.createTask({ title: 'Silent after ack', kind: 'research', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['notes'], actor: 'lead' })
      await value.dispatcher.reconcile('start')
      await value.taskStore.acknowledgeTask({ taskId: task.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      clock += 10 * 60 * 1000
      const pass = await value.dispatcher.reconcile('aged')
      expect(pass.stalled).toEqual([expect.objectContaining({ taskId: task.task.id, reason: 'idle' })])

      // A submission moves the ball to somebody else: waiting is not stalling.
      const other = await value.taskStore.createTask({ title: 'Submitted and waiting', kind: 'research', assignee: 'reviewer', route: { type: 'report', to: 'human' }, acceptance: ['notes'], actor: 'lead' })
      await value.taskStore.claimTask({ taskId: other.task.id, memberId: 'reviewer', sessionId: 's-reviewer', bindingGeneration: 1 })
      await value.taskStore.acknowledgeTask({ taskId: other.task.id, memberId: 'reviewer', sessionId: 's-reviewer', bindingGeneration: 1 })
      await writeFile(join(value.workspace, 'notes.md'), 'notes\n')
      await value.taskStore.submitTask({ taskId: other.task.id, memberId: 'reviewer', sessionId: 's-reviewer', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'notes.md' }, summary: 'notes', checks: [] })
      clock += 10 * 60 * 1000
      const later = await value.dispatcher.reconcile('aged again')
      expect(later.stalled.map((entry) => entry.taskId)).not.toContain(other.task.id)
    } finally { await value.cleanup() }
  })

  it('sends no assignment for a task that settled while the pass was running (F22)', async () => {
    const value = await fixture({ settleTaskOnClaim: true })
    try {
      const task = await value.taskStore.createTask({ title: 'Settles mid-pass', kind: 'research', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['notes'], actor: 'lead' })
      const pass = await value.dispatcher.reconcile('f22')
      // The claim may or may not have happened, but no assignment reaches the member, and the pass
      // says why: the human's acceptance is not something to dispatch over.
      expect(pass.started.filter((entry) => entry.taskId === task.task.id)).toEqual([])
      expect(pass.skipped).toContainEqual(expect.objectContaining({ taskId: task.task.id, reason: 'task-settled-during-pass' }))
      expect(value.texts.some((text) => text.includes(task.task.id))).toBe(false)
    } finally { await value.cleanup() }
  })

  it('starts no coding work when the deployment has not accepted it', async () => {
    const value = await fixture()
    try {
      const guarded = createDispatcher({
        workspacePath: value.workspace, teamId: 'team-1',
        readTeam: async () => await value.store.open(), taskStore: value.taskStore, mailbox: value.mailbox,
        appendAudit: async (event) => { value.audit.push(event as { kind?: string }) },
        sweepIntervalMs: 3_600_000,
      })
      try {
        const coding = await value.taskStore.createTask({ title: 'Write the code', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['tests pass'], actor: 'lead' })
        const research = await value.taskStore.createTask({ title: 'Read the docs', kind: 'research', assignee: 'reviewer', route: { type: 'report', to: 'human' }, acceptance: ['notes'], actor: 'lead' })
        const pass = await guarded.reconcile('test')
        expect(pass.started.map((entry) => entry.taskId)).toEqual([research.task.id])
        expect(pass.skipped.find((entry) => entry.taskId === coding.task.id)?.reason).toBe('coding-not-isolated')
        expect((await value.taskStore.listTasks()).find((entry) => entry.id === coding.task.id)?.status).toBe('ready')
        expect((await value.taskStore.readAttempts()).attempts.map((attempt) => attempt.taskId)).toEqual([research.task.id])
        expect((await guarded.reconcile('test')).started).toHaveLength(0)
      } finally { await guarded.stop() }
    } finally { await value.cleanup() }
  })

  it('repairs a claim whose assignment never went out, with the same attempt', async () => {
    const value = await fixture()
    try {
      const created = await value.taskStore.createTask({ title: 'Implement the thing', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['tests pass'], actor: 'lead' })
      // The crash window: the claim is durable, the member was never told.
      const claimed = await value.taskStore.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      expect(await value.mailbox.listMessages()).toHaveLength(0)
      const pass = await value.dispatcher.reconcile('test')
      expect(pass.started).toHaveLength(1)
      expect(pass.started[0]).toMatchObject({ attemptId: claimed.attempt.id, taskId: created.task.id })
      expect(pass.started[0]?.detail).toContain('repaired')
      const attempts = (await value.taskStore.readAttempts()).attempts
      expect(attempts).toHaveLength(1)
      const messages = await value.mailbox.listMessages()
      expect(messages).toHaveLength(1)
      expect(messages[0]?.threadId).toBe(assignmentThread(created.task.id, claimed.attempt.id))
      expect(kinds(value.audit).filter((kind) => kind === 'dispatch/assigned')).toHaveLength(1)
      // And the next pass is quiet again.
      expect((await value.dispatcher.reconcile('test')).started).toHaveLength(0)
      expect((await value.taskStore.readAttempts()).attempts).toHaveLength(1)
    } finally { await value.cleanup() }
  })

  it('never starts blocked work, and starts it once its dependency is completed', async () => {
    const value = await fixture({ members: [member('lead', 'Lead', 'lead', 's-lead'), member('worker', 'Builder', 'engineer', 's-worker'), member('reviewer', 'Tester', 'verifier', 's-reviewer'), member('worker2', 'Second', 'engineer', 's-worker2')] })
    try {
      const first = await value.taskStore.createTask({ title: 'First', kind: 'implementation', assignee: 'worker', route: { type: 'report', to: 'human' }, acceptance: ['ok'], actor: 'lead' })
      const dependent = await value.taskStore.createTask({ title: 'Second', kind: 'implementation', assignee: 'worker2', route: { type: 'report', to: 'human' }, acceptance: ['ok'], dependsOn: [first.task.id], actor: 'lead' })
      const pass = await value.dispatcher.reconcile('test')
      const blocked = pass.skipped.find((entry) => entry.taskId === dependent.task.id)
      expect(blocked).toMatchObject({ reason: 'dependency-open' })
      expect(blocked?.detail).toContain(first.task.id)
      expect(pass.started.map((entry) => entry.taskId)).toEqual([first.task.id])

      // Complete the dependency through the real path: submit a report, then accept it.
      const claimed = await value.taskStore.claimTask({ taskId: first.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      void claimed
      await value.taskStore.acknowledgeTask({ taskId: first.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(value.workspace, 'report.md'), 'report bytes')
      await value.taskStore.submitTask({ taskId: first.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'done', checks: [] })
      await value.taskStore.acceptTask({ taskId: first.task.id, actor: 'lead' })
      expect((await value.taskStore.listTasks({ includeArchived: true })).find((entry) => entry.id === first.task.id)?.status).toBe('completed')

      const next = await value.dispatcher.reconcile('test')
      expect(next.started.map((entry) => entry.taskId)).toEqual([dependent.task.id])
      expect((await value.taskStore.listTasks()).find((entry) => entry.id === dependent.task.id)?.status).toBe('claimed')
    } finally { await value.cleanup() }
  })

  it('respects availability and gives a member no second attempt', async () => {
    const value = await fixture()
    try {
      const first = await readyTask(value, { title: 'First' })
      const second = await readyTask(value, { title: 'Second' })
      const started = await value.dispatcher.reconcile('test')
      expect(started.started).toHaveLength(1)
      const busy = started.skipped.find((entry) => entry.reason === 'member-busy')
      expect(busy).toBeDefined()
      expect((await value.taskStore.readAttempts()).attempts.filter((attempt) => attempt.status === 'active')).toHaveLength(1)

      // Pause the member: the remaining task waits, and nothing new starts.
      const current = await value.store.open()
      await value.store.commit('team-1', { expectedRevision: current.revision, mutate: (state) => { const worker = state.members.find((entry) => entry.memberId === 'worker'); if (worker !== undefined) worker.availability = 'paused' } })
      const paused = await value.dispatcher.reconcile('test')
      expect(paused.started).toHaveLength(0)
      const waiting = first.id === started.started[0]?.taskId ? second.id : first.id
      expect(paused.skipped.find((entry) => entry.taskId === waiting)?.reason).toBe('member-paused')
      // A task whose reason changed is journaled once, not per pass, and the entry
      // names the reason it moved from.
      expect(paused.blocked).toHaveLength(1)
      expect(kinds(value.audit).filter((kind) => kind === 'dispatch/blocked')).toHaveLength(1)
      expect(value.audit.find((event) => event.kind === 'dispatch/blocked')).toMatchObject({ from: 'member-busy', reason: 'member-paused' })
      expect((await value.dispatcher.reconcile('test')).started).toHaveLength(0)
      expect(kinds(value.audit).filter((kind) => kind === 'dispatch/blocked')).toHaveLength(1)
    } finally { await value.cleanup() }
  })

  it('leaves a task alone while its attempt is revoking', async () => {
    const value = await fixture({ quiesce: false })
    try {
      const created = await readyTask(value)
      await value.dispatcher.reconcile('test')
      const revoked = await value.taskStore.revokeTask({ taskId: created.id, actor: 'lead', reason: 'unresponsive' })
      expect(revoked.attempt.status).toBe('revoking')
      expect(revoked.task.status).toBe('needs_human')
      const pass = await value.dispatcher.reconcile('test')
      expect(pass.started).toHaveLength(0)
      expect(pass.skipped.find((entry) => entry.taskId === created.id)?.reason).toBe('attempt-revoking')
      expect(pass.blocked.find((entry) => entry.taskId === created.id)?.reason).toBe('attempt-revoking')
      expect((await value.taskStore.readAttempts()).attempts).toHaveLength(1)
    } finally { await value.cleanup() }
  })

  it('does not wedge on a refused pass, and recovers when the team becomes active', async () => {
    // A pass that refuses before its first await used to leave the single-flight
    // latch holding a settled promise, so every later pass replayed that refusal.
    const value = await fixture()
    try {
      let active = false
      const reconciler = createDispatcher({
        workspacePath: value.workspace, teamId: 'team-1',
        readTeam: async () => await value.store.open(), taskStore: value.taskStore, mailbox: value.mailbox,
        appendAudit: async (event) => { value.audit.push(event as { kind?: string }) },
        codingDispatch: 'automatic',
        enabled: () => active, inactiveReason: () => 'the team is not active for this test',
        sweepIntervalMs: 3_600_000,
      })
      try {
        const created = await value.taskStore.createTask({ title: 'Implement the thing', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['tests pass'], actor: 'lead' })
        const refused = await reconciler.reconcile('first')
        expect(refused.failures).toEqual(['the team is not active for this test'])
        active = true
        const after = await reconciler.reconcile('second')
        expect(after.trigger).toBe('second')
        expect(after.failures).toEqual([])
        expect(after.started.map((entry) => entry.taskId)).toEqual([created.task.id])
      } finally { await reconciler.stop() }
    } finally { await value.cleanup() }
  })

  it('stops starts when paused but still delivers queued mail', async () => {
    const value = await fixture()
    try {
      const created = await readyTask(value)
      const current = await value.store.open()
      await value.store.setDispatchMode('team-1', 'paused', { actor: 'human:desktop', reason: 'maintenance' }, current.revision)
      const pass = await value.dispatcher.reconcile('test')
      expect(pass.paused).toBe(true)
      expect(pass.started).toHaveLength(0)
      expect((await value.taskStore.readAttempts()).attempts).toHaveLength(0)
      expect((await value.taskStore.listTasks())[0]?.status).toBe('ready')
      // The wake half is not paused: a message for a member still goes out.
      await value.mailbox.sendFromScheduler({ to: 'worker', kind: 'message', content: 'heads up' })
      const after = await value.dispatcher.reconcile('test')
      expect(after.paused).toBe(true)
      expect((await value.mailbox.listMessages()).length).toBe(1)
      expect((await value.mailbox.listDeliveries())[0]?.state).toBe('delivered')
      void created
    } finally { await value.cleanup() }
  })

  it('wakes a delivery that failed before the member had a Session', async () => {
    const value = await fixture({ members: [member('lead', 'Lead', 'lead', 's-lead'), member('reviewer', 'Tester', 'verifier', 's-reviewer'), member('worker', 'Builder', 'engineer')] })
    try {
      await value.mailbox.sendFromScheduler({ to: 'worker', kind: 'message', content: 'queued before the Session existed' })
      const failed = (await value.mailbox.listDeliveries())[0]
      expect(failed).toMatchObject({ state: 'failed', failure: NO_SESSION_FAILURE })

      const before = await value.dispatcher.reconcile('test')
      expect(before.woke).toHaveLength(0)

      const current = await value.store.open()
      await value.store.commit('team-1', { expectedRevision: current.revision, mutate: (state) => { const worker = state.members.find((entry) => entry.memberId === 'worker'); if (worker !== undefined) { worker.sessionId = 's-worker'; worker.bindingGeneration = 1 } } })
      value.setRecipients((await value.store.open()).members)
      const after = await value.dispatcher.reconcile('test')
      expect(after.woke).toHaveLength(1)
      expect((await value.mailbox.listDeliveries())[0]?.state).toBe('delivered')
      expect(kinds(value.audit).filter((kind) => kind === 'dispatch/woke')).toHaveLength(1)
    } finally { await value.cleanup() }
  })

  it('never revives a delivery that failed for another reason', async () => {
    const value = await fixture({ members: [member('lead', 'Lead', 'lead', 's-lead'), member('reviewer', 'Tester', 'verifier', 's-reviewer'), member('worker', 'Builder', 'engineer')] })
    try {
      await value.mailbox.sendFromScheduler({ to: 'worker', kind: 'comment', content: 'no wake by policy' })
      const current = await value.store.open()
      await value.store.commit('team-1', { expectedRevision: current.revision, mutate: (state) => { const worker = state.members.find((entry) => entry.memberId === 'worker'); if (worker !== undefined) { worker.sessionId = 's-worker' } } })
      value.setRecipients((await value.store.open()).members)
      const pass = await value.dispatcher.reconcile('test')
      expect(pass.woke).toHaveLength(0)
    } finally { await value.cleanup() }
  })
})
