import { describe, expect, it, vi } from 'vitest'
import { createSessionBridge } from './session-bridge.js'

function fixture(events?: unknown[], status = 'running') {
  const controller = { create: vi.fn(), inspect: vi.fn(async () => ({ meta: { id: 's-worker', workspaceId: 'ws' }, ...(events === undefined ? {} : { events }) })), rename: vi.fn(), prompt: vi.fn(), cancel: vi.fn() }
  const bridge = createSessionBridge({ controller, agents: { get: () => ({ status, session: { header: { id: 's-worker' } } }) } })
  return bridge
}
const start = { type: 'turn/start', seq: 1, data: { turn: 7 } }
const input = { type: 'user/message', seq: 2, data: { source: { kind: 'user', rpcId: 'return-request' }, content: 'Private body must not enter a receipt.' } }

describe('fresh Session human-activity observation', () => {
  it('distinguishes direct human input from accepted team commands without returning bodies', async () => {
    const bridge = fixture([{ ...input, time: 100 }])
    await expect(bridge.observeHumanActivity('s-worker', 50, ['return-request'])).resolves.toBe(false)
    await expect(bridge.observeHumanActivity('s-worker', 50, [])).resolves.toBe(true)
    await expect(bridge.observeHumanActivity('s-worker', 100, [])).resolves.toBe(false)
  })
  it('does not report absence of human input without observable events', async () => {
    await expect(fixture().observeHumanActivity('s-worker', 0, [])).resolves.toBeUndefined()
  })
})

describe('exact Session execution receipts', () => {
  it('does not mistake unrelated running work for processing the revision request', async () => {
    const bridge = fixture([start, { ...input, data: { source: { rpcId: 'unrelated-request' } } }])
    await expect(bridge.observeRequest('s-worker', 'return-request')).resolves.toMatchObject({ state: 'pending' })
  })
  it('confirms the matching input in its turn using metadata only', async () => {
    const bridge = fixture([start, input])
    const receipt = await bridge.observeRequest('s-worker', 'return-request')
    expect(receipt).toMatchObject({ state: 'started', turn: 7, inputSeq: 2 })
    expect(JSON.stringify(receipt)).not.toContain('Private body')
  })
  it('recognizes a quickly completed matching turn even though the Session is idle now', async () => {
    const bridge = fixture([start, input, { type: 'turn/end', seq: 3, data: { turn: 7, reason: { kind: 'completed' } } }], 'idle')
    await expect(bridge.observeRequest('s-worker', 'return-request')).resolves.toMatchObject({ state: 'completed', turn: 7, inputSeq: 2 })
  })
  it('reports a failed matching turn rather than merely claiming the request started', async () => {
    const bridge = fixture([start, input, { type: 'turn/end', seq: 3, data: { turn: 7, reason: { kind: 'error' } } }], 'idle')
    await expect(bridge.observeRequest('s-worker', 'return-request')).resolves.toMatchObject({ state: 'failed', turn: 7, reason: 'error' })
  })
  it('reports absent inspection capability as unobservable, not success', async () => {
    await expect(fixture().observeRequest('s-worker', 'return-request')).resolves.toMatchObject({ state: 'unobservable' })
  })
})
