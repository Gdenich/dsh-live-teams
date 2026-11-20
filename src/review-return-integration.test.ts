import { mkdtemp, realpath, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamStore } from './team-store.js'
import { createTaskStore } from './task-store.js'
import { createMailbox, type MailboxService } from './mailbox.js'
import { createCommandQueue } from './command-queue.js'
import { createSessionBridge } from './session-bridge.js'
import { createReviewReturnPorts, reviewReturnLeadDeliveryAllowed } from './review-return-ports.js'
import { createReviewReturnGuard } from './review-return-guard.js'

describe('durable automatic review return composition', () => {
  it.each(['ordinary', 'fresh-human', 'late-pause'])('uses real stores/outbox/queue/ports safely for %s', async scenario => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-return-composition-'))
    try {
      const team = new TeamStore({ workspacePath: workspace, workspaceId: 'ws', teamId: 'team-1' })
      const opened = await team.open()
      await team.commit('team-1', { expectedRevision: opened.revision, mutate: state => {
        state.leadMemberId = 'lead'
        for (const [memberId, role] of [['lead', 'lead'], ['worker', 'builder'], ['reviewer', 'reviewer']]) state.members.push({ memberId: memberId!, role: role!, displayName: memberId!, availability: 'available', sessionId: `s-${memberId}`, bindingGeneration: 1, contractRevision: 0 })
      } })
      const events = new Map<string, unknown[]>([['s-worker', []], ['s-lead', []]])
      const prompts: Array<{ sessionId: string; requestId: string }> = []
      const bridge = createSessionBridge({ controller: {
        create: async () => undefined, rename: async () => undefined, cancel: () => undefined,
        inspect: async sessionId => ({ meta: { id: sessionId }, events: events.get(sessionId) }),
        prompt: async payload => {
          prompts.push({ sessionId: payload.sessionId, requestId: payload.requestId })
          const history = events.get(payload.sessionId)!
          const turn = history.length + 1
          history.push({ type: 'turn/start', seq: history.length + 1, time: Date.now(), data: { turn } }, { type: 'user/message', seq: history.length + 2, time: Date.now(), data: { source: { kind: 'user', rpcId: payload.requestId }, content: payload.content } })
        },
      } })
      let mailbox: MailboxService
      const ports = createReviewReturnPorts({ mailbox: () => mailbox, bridge, teamId: 'team-1', observationTimeoutMs: 0 })
      const store = createTaskStore({ workspacePath: workspace, teamId: 'team-1', ...ports, appendAudit: async event => team.appendEvent('team-1', event) })
      const guard = createReviewReturnGuard({ store, bridge, readEvents: async () => (await team.readEvents('team-1', 0)).events, knownRequestIds: async sessionId => (await queue.list()).filter(record => record.sessionId === sessionId).map(record => record.requestId) })
      const queue = createCommandQueue({ workspacePath: workspace, teamId: 'team-1', deliver: async record => {
        if (record.sessionId === 's-worker' && scenario === 'fresh-human') events.get('s-worker')!.push({ type: 'user/message', seq: 1, time: Date.now() + 1, data: { source: { kind: 'user', rpcId: 'direct-human' }, content: 'Private authoritative dialogue.' } })
        if (record.sessionId === 's-worker' && scenario === 'late-pause') {
          const state = await team.open()
          await team.commit('team-1', { expectedRevision: state.revision, mutate: draft => { draft.dispatch = { mode: 'paused', at: Date.now(), by: 'human:desktop' } } })
        }
        const message = await mailbox.getMessage(record.causationId!)
        if (message === undefined || (!await guard(message, record.sessionId, record.bindingGeneration) || !await reviewReturnLeadDeliveryAllowed(store, message, record.sessionId, record.bindingGeneration))) throw new Error('current authority rejected')
        await bridge.deliver(record.sessionId, { requestId: record.requestId, mode: record.mode, content: record.content })
      } })
      mailbox = createMailbox({ workspacePath: workspace, teamId: 'team-1', queue, listRecipients: async () => (await team.open()).members.map(member => ({ memberId: member.memberId, sessionId: member.sessionId!, bindingGeneration: member.bindingGeneration })), canDeliver: async (message, recipient) => await guard(message, recipient.sessionId, recipient.bindingGeneration) && await reviewReturnLeadDeliveryAllowed(store, message, recipient.sessionId, recipient.bindingGeneration) })
      const created = await store.createTask({ title: 'Existing work', kind: 'implementation', assignee: 'worker', route: { type: 'review', reviewer: 'reviewer' }, acceptance: ['Do not rewrite the contract'], paths: ['report.md'], actor: 'lead', roundLimit: 2 })
      const claim = await store.claimTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await store.acknowledgeTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1 })
      await writeFile(join(workspace, 'report.md'), '# Original')
      const submitted = await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Review this', checks: [] })
      const result = await store.reviewTask({ taskId: created.task.id, submissionId: submitted.submission.id, reviewerMemberId: 'reviewer', verdict: 'needs_revision', findings: [{ severity: 'high', problem: 'Missing case', requiredFix: 'Fix it without scope changes\nСохранить контракт.' }], evidence: [{ command: 'touch must-not-execute', status: 'failed' }] })
      expect(result.task.contractRevision).toBe(created.task.contractRevision)
      expect(result.task.activeAttemptId).toBe(claim.attempt.id)
      expect(result.task.roundLimit).toBe(2)
      expect((await store.readAttempts()).attempts).toHaveLength(1)
      if (scenario === 'ordinary') {
        expect(result.task.reviewReturn).toMatchObject({ state: 'started', leadNotified: true })
        const reopened = createTaskStore({ workspacePath: workspace, teamId: 'team-1', ...ports })
        await Promise.all([store.recoverReviewReturns(), reopened.recoverReviewReturns()])
        expect(prompts.filter(prompt => prompt.sessionId === 's-worker')).toHaveLength(1)
        expect((await mailbox.listMessages()).filter(message => message.threadId?.startsWith('review-return/v1:'))).toHaveLength(1)
        expect(result.notifications).toMatchObject([{ recipient: 'worker', state: 'queued', purpose: 'review-return' }, { recipient: 'lead', state: 'queued', purpose: 'review-return-lead', sessionId: 's-lead', bindingGeneration: 1 }])
        events.set('s-lead-new', [])
        const current = await team.open()
        await team.commit('team-1', { expectedRevision: current.revision, mutate: draft => { const lead = draft.members.find(member => member.memberId === 'lead')!; lead.sessionId = 's-lead-new'; lead.bindingGeneration++ } })
        await Promise.all([store.recoverReviewReturns(), reopened.recoverReviewReturns()])
        expect(prompts.filter(prompt => prompt.sessionId === 's-lead-new')).toHaveLength(1)
        expect(prompts.filter(prompt => prompt.sessionId === 's-worker')).toHaveLength(1)
        expect((await store.readTask(created.task.id)).task.reviewReturn?.leadNotification).toMatchObject({ state: 'queued', sessionId: 's-lead-new', bindingGeneration: 2 })
        await writeFile(join(workspace, 'report.md'), '# Corrected')
        await store.submitTask({ taskId: created.task.id, memberId: 'worker', sessionId: 's-worker', bindingGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md' }, summary: 'Corrected', checks: [] })
        await Promise.all([store.recoverReviewReturns(), reopened.recoverReviewReturns()])
        expect(prompts.filter(prompt => prompt.sessionId === 's-lead')).toHaveLength(1)
      } else {
        expect(prompts.filter(prompt => prompt.sessionId === 's-worker')).toHaveLength(0)
        expect(result.task.reviewReturn?.state).toBe(scenario === 'fresh-human' ? 'blocked' : 'superseded')
        if (scenario === 'fresh-human') expect(result.task.status).toBe('waiting')
      }
      expect(prompts.filter(prompt => prompt.sessionId === 's-lead')).toHaveLength(1)
      await expect(stat(join(workspace, 'must-not-execute'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.stringify((await team.readEvents('team-1', 0)).events)).not.toContain('Private authoritative dialogue')
    } finally {
      const target = await realpath(workspace)
      const temp = await realpath(tmpdir())
      if (!target.startsWith(join(temp, 'live-teams-return-composition-'))) throw new Error('unexpected cleanup target')
      await rm(target, { recursive: true, force: true })
    }
  })
})
