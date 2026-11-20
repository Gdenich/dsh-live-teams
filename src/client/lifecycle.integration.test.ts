import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTeamTask, updateTeamTask, revokeTeamTask, resumeTeamTask, cancelTeamTask, fetchTeamInbox, acceptTeamTask, reviseTeamTask } from './api.js'
import { createMailbox, type MailboxService } from '../mailbox.js'
import { registerLiveTeamsRoutes, type LiveTeamsResponse } from '../routes.js'
import { TeamStore } from '../team-store.js'
import { createTaskStore, type TaskStore } from '../task-store.js'

type RouteHandler = (request: { method?: string; headers: Record<string, string>; socket: { remoteAddress?: string }; url?: string; body?: string }, response: LiveTeamsResponse) => unknown
const mutationHeaders = { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
function response(): LiveTeamsResponse & { body: string | undefined; headers: Record<string, string> } {
  return { statusCode: 0, body: undefined, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = body } }
}
function routeOf(readState: () => Promise<unknown>, agents: { get: (id: string) => unknown }, extra: { workspacePath?: string; taskStore?: TaskStore; mailbox?: MailboxService }) {
  const handlers = new Map<string, RouteHandler>()
  const unregister = registerLiveTeamsRoutes({ webServer: { port: 43120, register(route) { handlers.set(route.path, route.handler as RouteHandler); return () => undefined } } }, { teamId: 'team-1', workspacePath: '/workspace', readState, agents, ...extra })
  return { handlers, unregister }
}

function connectClient(route: { handlers: Map<string, RouteHandler> }): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:43120')
    const handler = route.handlers.get(url.pathname)
    if (handler === undefined) throw new Error(`unregistered route: ${url.pathname}`)
    const result = response()
    await handler({ method: init?.method ?? 'GET', headers: mutationHeaders, socket: { remoteAddress: '127.0.0.1' }, url: `${url.pathname}${url.search}`, ...(typeof init?.body === 'string' ? { body: init.body } : {}) }, result)
    return new Response(result.body, { status: result.statusCode, headers: result.headers })
  })
}

describe('real client, HTTP handlers and lifecycle store', () => {
  it('preserves authored Russian text through mailbox storage, HTTP inbox and client parsing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-inbox-roundtrip-'))
    const content = 'Проверка завершена: PASS.\n\n- `make check` — exit 0.\n- Два  пробела сохранены.\n\nПолные результаты — в вердикте.'
    let dispose: (() => void) | undefined
    try {
      const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      const opened = await team.open()
      await team.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => {
        state.members.push({ memberId: 'm-reviewer', displayName: 'Reviewer', role: 'reviewer', availability: 'available', sessionId: 's-reviewer', bindingGeneration: 1, contractRevision: 0 })
      } })
      const mailbox = createMailbox({ workspacePath: workspace, teamId: 'team-1', autoDeliver: false,
        listRecipients: async () => [{ memberId: 'm-reviewer', displayName: 'Reviewer', sessionId: 's-reviewer', bindingGeneration: 1, active: true }],
        resolveSessionSender: (sessionId) => sessionId === 's-reviewer' ? 'm-reviewer' : undefined,
        queue: { admit: async () => { throw new Error('human inbox must not queue a runtime command') }, dispatch: async () => { throw new Error('human inbox must not dispatch a runtime command') } },
      })
      const authored = await mailbox.sendFromSession('s-reviewer', { to: 'human', kind: 'message', content })
      const route = routeOf(async () => team.open(), { get: () => undefined }, { workspacePath: workspace, mailbox })
      dispose = route.unregister
      connectClient(route)
      const inbox = await fetchTeamInbox('s-reviewer')
      expect(inbox.messages.find((entry) => entry.id === authored.message.id)?.content).toBe(content)
      expect((await mailbox.getMessage(authored.message.id))?.content).toBe(content)
    } finally {
      vi.unstubAllGlobals()
      dispose?.()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('round-trips the real store and route responses through the real client lifecycle parsers', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-client-routes-'))
    let dispose: (() => void) | undefined
    try {
      const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      const opened = await team.open()
      await team.commit('team-1', { expectedRevision: opened.revision, mutate: (state) => {
        state.leadMemberId = 'm-lead'
        state.members.push({ memberId: 'm-lead', displayName: 'Lead', role: 'lead', availability: 'available', sessionId: 's-lead', bindingGeneration: 1, contractRevision: 0 })
        state.members.push({ memberId: 'm-worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 's-worker', bindingGeneration: 1, contractRevision: 0 })
      } })
      let quiesced = true
      const interrupts: string[] = []
      const directions: string[] = []
      const closings: string[] = []
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', appendAudit: async () => undefined, interruptSession: async (sessionId) => { interrupts.push(sessionId) }, awaitQuiescence: async () => quiesced, deliverDirection: async ({ instructions }) => { directions.push(instructions) }, deliverClosing: async ({ taskId }) => { closings.push(taskId) } })
      const route = routeOf(async () => team.open(), { get: () => undefined }, { workspacePath: workspace, taskStore: store })
      dispose = route.unregister
      connectClient(route)
      const created = await createTeamTask({ title: 'Controlled work', kind: 'work', assignee: 'm-worker', route: { type: 'report', to: 'human' }, acceptance: ['done'], paths: ['future/**'] }, 's-lead')
      expect(created.warnings).toMatchObject([{ code: 'path-no-match', pattern: 'future/**' }])
      const taskId = created.task.id
      expect((await updateTeamTask({ taskId, title: 'Corrected work' }, 's-lead')).changed).toContain('title')
      await store.claimTask({ taskId, memberId: 'm-worker', sessionId: 's-worker', bindingGeneration: 1 })
      expect((await revokeTeamTask({ taskId, reason: 'fix before restarting' }, 's-lead')).task.status).toBe('draft')
      expect((await updateTeamTask({ taskId, title: 'Still parked' }, 's-lead')).task.status).toBe('draft')
      expect((await resumeTeamTask(taskId, 's-lead')).task.status).toBe('ready')
      expect((await store.claimTask({ taskId, memberId: 'm-worker', sessionId: 's-worker', bindingGeneration: 1 })).attempt.generation).toBe(2)
      quiesced = false
      const pending = await cancelTeamTask(taskId, 'superseded', 's-lead')
      expect(pending).toMatchObject({ quiesced: false, task: { status: 'needs_human' } })
      expect(pending.archivedPath).toBeUndefined()
      quiesced = true
      const cancelled = await cancelTeamTask(taskId, 'superseded', 's-lead')
      expect(cancelled).toMatchObject({ quiesced: true, task: { status: 'cancelled' } })
      expect(cancelled.archivedPath).toBeDefined()
      expect(interrupts).toEqual(['s-worker', 's-worker', 's-worker'])
      await expect(cancelTeamTask(taskId, 'again', 's-lead')).rejects.toThrow('already cancelled')
      await expect(resumeTeamTask(taskId, 's-lead')).rejects.toThrow('parked draft')
      expect(closings).toEqual([])

      // Acceptance and revision have different results from cancellation; run their
      // real response shapes through the same parsers as the panel, not canned JSON.
      const decision = await createTeamTask({ title: 'Report decision', kind: 'work', assignee: 'm-worker', route: { type: 'report', to: 'human' }, acceptance: ['complete report'] }, 's-lead')
      const decisionId = decision.task.id
      const actor = { taskId: decisionId, memberId: 'm-worker', sessionId: 's-worker', bindingGeneration: 1 }
      await store.claimTask(actor)
      await store.acknowledgeTask(actor)
      const report = join(workspace, 'report.md')
      await writeFile(report, 'First immutable report')
      const artifact = { type: 'report' as const, bodyRef: 'report.md' }
      await store.submitTask({ ...actor, artifact, summary: 'first submission', checks: [] })
      expect((await reviseTeamTask(decisionId, 'Include the missing result', 's-lead')).task.status).toBe('in_progress')
      expect(directions).toEqual(['Include the missing result'])
      await writeFile(report, 'Second immutable report with the missing result')
      const submitted = await store.submitTask({ ...actor, artifact, summary: 'second submission', checks: [] })
      const accepted = await acceptTeamTask(decisionId, 'Reviewed and accepted', 's-lead')
      expect(accepted.task.status).toBe('completed')
      expect(accepted.task.acceptedSubmissionId).toBe(submitted.submission.id)
      expect(accepted.archivedPath).toBeDefined()
      expect(closings).toEqual([decisionId])
      expect((await store.readTask(decisionId)).attempts[0]?.status).toBe('completed')
      expect((await store.readTask(decisionId)).submissions).toHaveLength(2)
      expect(interrupts).toEqual(['s-worker', 's-worker', 's-worker'])
    } finally {
      vi.unstubAllGlobals()
      dispose?.()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
