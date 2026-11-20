import { describe, expect, it } from 'vitest'
import { createSessionBridge } from './session-bridge.js'

class PlatformError extends Error { code: string; details: Record<string, unknown>; constructor(code: string, message: string, details: Record<string, unknown> = {}) { super(message); this.name = 'RemoteError'; this.code = code; this.details = details } }
type Overrides = { inspect?: (id: string) => unknown; create?: (payload: Record<string, unknown>) => unknown; rename?: (payload: { sessionId: string; title: string }) => unknown; prompt?: (payload: unknown) => unknown; cancel?: (payload: unknown) => unknown; calls?: unknown[] }
function fakeController(overrides: Overrides = {}) {
  const calls = overrides.calls ?? []
  return { calls,
    async create(payload: Record<string, unknown>) { calls.push(['create', payload]); return overrides.create?.(payload) ?? { sessionId: payload.sessionId } },
    async inspect(sessionId: string) { calls.push(['inspect', sessionId]); return overrides.inspect?.(sessionId) ?? { meta: { id: sessionId, cwd: '/w', workspaceId: 'ws-1' }, events: [] } },
    async rename(payload: { sessionId: string; title: string }) { calls.push(['rename', payload]); return overrides.rename?.(payload) ?? { title: payload.title, seq: 7 } },
    async prompt(payload: unknown, signal: AbortSignal) { calls.push(['prompt', payload, signal !== undefined]); return overrides.prompt?.(payload) ?? { accepted: true } },
    cancel(payload: unknown) { calls.push(['cancel', payload]); return overrides.cancel?.(payload) ?? { accepted: true } },
  }
}
function bridgeOf(controller: ReturnType<typeof fakeController>, agents?: { get?: (id: string) => unknown }) { return createSessionBridge({ controller, ...(agents === undefined ? {} : { agents }) }) }

describe('SessionBridge', () => {
  it('create sends verified fields', async () => { const controller = fakeController(); const descriptor = await bridgeOf(controller).create({ sessionId: 's-1', workspaceId: 'ws-1', cwd: '/w' }); expect(controller.calls[0]).toEqual(['create', { sessionId: 's-1', workspaceId: 'ws-1', cwd: '/w' }]); expect(descriptor.sessionId).toBe('s-1'); expect(descriptor.live).toBe(false); expect(descriptor.status).toBe('unknown') })
  it('create requires explicit id', async () => { await expect(bridgeOf(fakeController()).create({})).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' }) })
  it('inspect returns undefined for uncoded not-found', async () => { expect(await bridgeOf(fakeController({ inspect: (id) => { throw new Error(`session "${id}" not found`) } })).inspect('s-missing')).toBeUndefined() })
  it('inspect returns undefined for coded not-found', async () => { expect(await bridgeOf(fakeController({ inspect: () => { throw new PlatformError('session/not-found', 'gone') } })).inspect('s')).toBeUndefined() })
  it('descriptor reports title seq live and preset', async () => { const descriptor = await bridgeOf(fakeController({ inspect: () => ({ meta: { id: 's-2', agentPreset: 'engineer' }, events: [{ type: 'turn/start', seq: 1 }, { type: 'session/title', seq: 4, data: { title: 'Builder' } }] }) }), { get: () => ({ status: 'running' }) }).inspect('s-2'); expect(descriptor?.title).toBe('Builder'); expect(descriptor?.seq).toBe(4); expect(descriptor?.status).toBe('running'); expect(descriptor?.live).toBe(true); expect(descriptor?.agentPreset).toBe('engineer') })
  it('validateAttachment rejects other workspace', async () => { await expect(bridgeOf(fakeController({ inspect: () => ({ meta: { id: 's-3', workspaceId: 'ws-other' }, events: [] }) })).validateAttachment('s-3', 'ws-1')).rejects.toMatchObject({ code: 'SESSION_WRONG_WORKSPACE' }) })
  it('validateAttachment rejects subagent', async () => { await expect(bridgeOf(fakeController({ inspect: () => ({ meta: { id: 's-4', workspaceId: 'ws-1', origin: 'subagent', parentSession: 'parent' }, events: [] }) })).validateAttachment('s-4', 'ws-1')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' }) })
  it('validateAttachment reports missing', async () => { await expect(bridgeOf(fakeController({ inspect: () => { throw new PlatformError('session/not-found', 'gone') } })).validateAttachment('s-5', 'ws-1')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' }) })
  it('rename returns title and sequence', async () => { await expect(bridgeOf(fakeController()).rename('s-6', 'New title')).resolves.toEqual({ title: 'New title', seq: 7 }) })
  it('selectModel refuses', () => { expect(() => bridgeOf(fakeController()).selectModel('s', {})).toThrowError(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE', auditDetail: expect.stringMatching(/default model/i) })) })
  it('deliver forwards exact prompt', async () => { const controller = fakeController(); await expect(bridgeOf(controller).deliver('s-7', { requestId: 'r-1', mode: 'steer', content: [{ type: 'text', text: 'redirect' }] })).resolves.toEqual({ accepted: true }); expect(controller.calls[0]).toEqual(['prompt', { requestId: 'r-1', sessionId: 's-7', mode: 'steer', content: [{ type: 'text', text: 'redirect' }] }, true]) })
  it('deliver rejects unsupported mode', async () => { const controller = fakeController(); await expect(bridgeOf(controller).deliver('s-8', { requestId: 'r-2', mode: 'broadcast' as 'queue', content: [] })).rejects.toMatchObject({ code: 'DELIVERY_REJECTED' }); expect(controller.calls).toHaveLength(0) })
  it('deliver maps busy', async () => { await expect(bridgeOf(fakeController({ prompt: () => { throw new PlatformError('session/agent-busy', 'prompt rejected', { reason: 'cannot admit' }) } })).deliver('s-9', { requestId: 'r-3', mode: 'queue', content: [] })).rejects.toMatchObject({ code: 'SESSION_BUSY' }) })
  it('deliver refuses subagent busy', async () => { await expect(bridgeOf(fakeController({ prompt: () => { throw new PlatformError('session/agent-busy', 'owned', { reason: 'use subagent delivery for this child session' }) } })).deliver('s-10', { requestId: 'r-4', mode: 'queue', content: [] })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' }) })
  it('interrupt cancels synchronously', async () => { const controller = fakeController(); await expect(bridgeOf(controller).interrupt('s-11', 'human pause')).resolves.toEqual({ accepted: true }); expect(controller.calls[0]).toEqual(['cancel', { sessionId: 's-11' }]) })
  it('interrupt maps missing', async () => { await expect(bridgeOf(fakeController({ cancel: () => { throw new PlatformError('session/not-found', 'gone') } })).interrupt('s-12', 'reason')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' }) })
  it('reconcile skips missing', async () => { const descriptors = await bridgeOf(fakeController({ inspect: (id) => id === 'gone' ? (() => { throw new PlatformError('session/not-found', 'gone') })() : { meta: { id, workspaceId: 'ws-1' }, events: [] } })).reconcile(['alive', 'gone']); expect(descriptors.map((entry) => entry.sessionId)).toEqual(['alive']) })
  it('composition without controller fails loudly', () => { expect(() => createSessionBridge({ controller: undefined })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' })) })

  // DSH 0.2.2-rc.1 removed sessionController.inspect; ctx.sessionQuery.load returns the same
  // header and events. These regressions keep both host generations working.
  it('inspects through sessionQuery.load when the controller has no inspect', async () => {
    const { inspect: _removed, ...controller } = fakeController()
    const bridge = createSessionBridge({ controller, sessionQuery: { load: async (id: string) => ({ header: { id, cwd: '/w', workspaceId: 'ws-1', agentPreset: 'builder' }, inheritedEventCount: 0, events: [] }) } })
    const descriptor = await bridge.inspect('s-load')
    expect(descriptor?.workspaceId).toBe('ws-1')
    expect(descriptor?.cwd).toBe('/w')
    expect(descriptor?.agentPreset).toBe('builder')
  })

  it('observes an exact prompt through sessionQuery.load', async () => {
    const { inspect: _removed, ...controller } = fakeController()
    const events: Array<Record<string, unknown>> = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 5, data: { source: { kind: 'user', rpcId: 'r-load' } } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const bridge = createSessionBridge({ controller, sessionQuery: { load: async (id: string) => ({ header: { id }, events }) } })
    await expect(bridge.observeRequest('s-load', 'r-load')).resolves.toEqual({ state: 'completed', turn: 1, inputSeq: 2 })
    await expect(bridge.observeHumanActivity('s-load', 0, ['r-load'])).resolves.toBe(false)
    events.push({ type: 'user/message', seq: 4, time: 10, data: { source: { kind: 'user', rpcId: 'human-direct' } } })
    await expect(bridge.observeHumanActivity('s-load', 0, ['r-load'])).resolves.toBe(true)
  })

  it('still prefers controller.inspect when an older host offers both', async () => {
    const controller = fakeController({ inspect: () => ({ meta: { id: 's-old' }, events: [] }) })
    const bridge = createSessionBridge({ controller, sessionQuery: { load: () => { throw new Error('load must not be used') } } })
    await expect(bridge.inspect('s-old')).resolves.toMatchObject({ sessionId: 's-old' })
  })

  it('inspects a live Session when no inspection service is reachable', async () => {
    const { inspect: _removed, ...controller } = fakeController()
    const bridge = createSessionBridge({
      controller,
      liveSession: (id: string) => ({ header: { id, cwd: '/w', workspaceId: 'ws-live' }, inheritedEventCount: 0, snapshotEvents: () => [] }),
    })
    await expect(bridge.inspect('s-live')).resolves.toMatchObject({ sessionId: 's-live', workspaceId: 'ws-live', cwd: '/w' })
  })

  it('falls back to the visible Session list for a cold descriptor', async () => {
    const { inspect: _removed, ...controllerBase } = fakeController()
    const controller = { ...controllerBase, async list() { return { items: [{ sessionId: 's-cold', cwd: '/w', workspaceId: 'ws-cold' }] } } }
    const bridge = createSessionBridge({ controller })
    await expect(bridge.inspect('s-cold')).resolves.toMatchObject({ sessionId: 's-cold', cwd: '/w', workspaceId: 'ws-cold' })
  })

  it('resolves sessionQuery lazily when the service appears after mount', async () => {
    const { inspect: _removed, ...controller } = fakeController()
    let query: { load?: (id: string) => Promise<unknown> } | undefined
    const bridge = createSessionBridge({ controller, sessionQuery: () => query })
    await expect(bridge.inspect('s-late')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    query = { load: async (id: string) => ({ header: { id, workspaceId: 'ws-late' }, events: [] }) }
    await expect(bridge.inspect('s-late')).resolves.toMatchObject({ sessionId: 's-late', workspaceId: 'ws-late' })
  })

  it('refuses inspection when the host offers neither API', async () => {
    const { inspect: _removed, ...controller } = fakeController()
    await expect(createSessionBridge({ controller }).inspect('s-none')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })
})
