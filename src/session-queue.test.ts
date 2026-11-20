import { describe, expect, it, vi } from 'vitest'
import { createSessionBridge } from './session-bridge.js'
function fixture(options: { live?: boolean; pending?: boolean; consume?: boolean } = {}) {
  const item = { id: 'own-queued-item', source: { kind: 'user', rpcId: 'team:message:worker:queue' }, content: 'private content' }
  const agent = { id: 's-worker', session: { header: { id: 's-worker' } }, inbox: { nextTurn: options.pending === false ? [] : [item, { id: 'human-item', source: { kind: 'user', rpcId: 'human-rpc' } }], nextStep: [] } }
  const updateQueue = vi.fn(async () => { if (options.consume) throw { code: 'session/queue-item-not-found' }; return {} })
  const controller = { create: vi.fn(), inspect: vi.fn(), rename: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), updateQueue }
  const bridge = createSessionBridge({ controller, agents: { get: () => options.live === false ? undefined : agent } })
  return { bridge, controller, updateQueue }
}
describe('exact pending native request removal', () => {
  it('removes only the pending item matching the plugin request identity', async () => {
    const f = fixture()
    expect(await f.bridge.removeQueuedRequest('s-worker', 'team:message:worker:queue')).toMatchObject({ state: 'removed', itemId: 'own-queued-item' })
    expect(f.updateQueue).toHaveBeenCalledWith({ sessionId: 's-worker', itemId: 'own-queued-item', action: { kind: 'remove' } })
    expect(f.controller.cancel).not.toHaveBeenCalled()
  })
  it('does not touch other input when the request is already consumed', async () => {
    const f = fixture({ pending: false })
    expect(await f.bridge.removeQueuedRequest('s-worker', 'team:message:worker:queue')).toMatchObject({ state: 'not-pending' })
    expect(f.updateQueue).not.toHaveBeenCalled()
  })
  it('does not resume an unloaded agent in order to clear its queue', async () => {
    const f = fixture({ live: false })
    expect(await f.bridge.removeQueuedRequest('s-worker', 'team:message:worker:queue')).toMatchObject({ state: 'unobservable' })
    expect(f.updateQueue).not.toHaveBeenCalled()
    expect(f.controller.create).not.toHaveBeenCalled()
    expect(f.controller.inspect).not.toHaveBeenCalled()
  })
  it('reports the native consume/remove race as not-pending, not a cancelled turn', async () => {
    const f = fixture({ consume: true })
    expect(await f.bridge.removeQueuedRequest('s-worker', 'team:message:worker:queue')).toMatchObject({ state: 'not-pending' })
    expect(f.controller.cancel).not.toHaveBeenCalled()
  })
})
