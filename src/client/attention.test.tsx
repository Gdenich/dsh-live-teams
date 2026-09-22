// @vitest-environment happy-dom
/**
 * The attention chip is the replacement for "go and look at the Messages panel":
 * it must appear from anywhere, name who is waiting, and take the human to that
 * member's Session — the one place where the conversation actually happens.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { AttentionChip, acknowledgeMemberWaiting, attentionLabel, currentSessionId, resetAttentionClears, type AttentionContext } from './attention.js'
import type { TeamAttentionEntry } from './api.js'
import type { LocaleKey } from './locales.js'

const t = (key: LocaleKey): string => (key === 'attentionWaiting' ? 'is waiting for you' : key)

function sessionsService(current: string | undefined, open = vi.fn()): AttentionContext['sessions'] {
  return {
    open,
    list: {
      getSnapshot: () => (current === undefined ? {} : { current }),
      subscribe: () => () => {},
    },
  }
}

function attentionPayload(entries: unknown[]): Response {
  return new Response(JSON.stringify({ teamId: 'team-1', attention: entries }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function inboxPayload(messages: unknown[]): Response {
  return new Response(JSON.stringify({ teamId: 'team-1', messages }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const entry: TeamAttentionEntry = { memberId: 'z-live', name: 'Zed', sessionId: 'session-zed', waiting: 3, since: 10, kind: 'comment' }

async function render(ctx: AttentionContext): Promise<{ view: HTMLDivElement; root: Root }> {
  const view = document.createElement('div')
  document.body.append(view)
  const root = createRoot(view)
  await act(async () => { root.render(React.createElement(AttentionChip, { ctx })) })
  await act(async () => { await Promise.resolve() })
  return { view, root }
}

afterEach(() => { vi.unstubAllGlobals(); resetAttentionClears(); document.body.innerHTML = '' })

describe('attention chip', () => {
  it('speaks for the Session being viewed, which the slot cannot pass as a prop', () => {
    expect(currentSessionId(sessionsService('session-zed'))).toBe('session-zed')
    expect(currentSessionId(sessionsService(undefined))).toBeUndefined()
    expect(currentSessionId(undefined)).toBeUndefined()
  })

  it('summarises the queue as the longest wait plus how many follow', () => {
    expect(attentionLabel([])).toBeUndefined()
    expect(attentionLabel([entry])).toEqual({ name: 'Zed', extra: 0, waiting: 3 })
    expect(attentionLabel([entry, { ...entry, memberId: 'm-2', name: 'Ada' }])).toEqual({ name: 'Zed', extra: 1, waiting: 3 })
  })

  it('renders nothing while nobody is waiting', async () => {
    vi.stubGlobal('fetch', async () => attentionPayload([]))
    const { view } = await render({ sessions: sessionsService('session-zed'), t })
    expect(view.querySelector('.dshLiveTeamsAttention')).toBeNull()
  })

  it('names the member who is waiting', async () => {
    vi.stubGlobal('fetch', async () => attentionPayload([entry]))
    const { view } = await render({ sessions: sessionsService('session-zed'), t })
    const chip = view.querySelector<HTMLButtonElement>('.dshLiveTeamsAttention')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('Zed')
    expect(chip?.textContent).toContain('3')
    expect(chip?.getAttribute('title')).toBe('is waiting for you')
  })

  it('opens the member Session and clears what was waiting', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
      if (url.includes('/attention')) return attentionPayload([entry])
      if (url.includes('/messages/acknowledge')) return new Response(JSON.stringify({ messageIds: ['msg-1', 'msg-2', 'msg-3'], state: 'acknowledged' }), { status: 200, headers: { 'content-type': 'application/json' } })
      return inboxPayload([
        { id: 'msg-1', from: 'z-live', fromName: 'Zed', kind: 'comment', content: 'a', createdAt: 1, delivery: { id: 'd-1', state: 'stored' } },
        { id: 'msg-2', from: 'z-live', fromName: 'Zed', kind: 'comment', content: 'b', createdAt: 2, delivery: { id: 'd-2', state: 'stored' } },
        { id: 'msg-3', from: 'z-live', fromName: 'Zed', kind: 'comment', content: 'c', createdAt: 3, delivery: { id: 'd-3', state: 'stored' } },
        // Already read, so it must not be sent again.
        { id: 'msg-old', from: 'z-live', fromName: 'Zed', kind: 'comment', content: 'd', createdAt: 0, delivery: { id: 'd-4', state: 'acknowledged' } },
        // Another member's waiting message is not this click's business.
        { id: 'msg-other', from: 'ada', fromName: 'Ada', kind: 'comment', content: 'e', createdAt: 4, delivery: { id: 'd-5', state: 'stored' } },
      ])
    })
    const open = vi.fn()
    const { view } = await render({ sessions: sessionsService('session-zed', open), t })
    const chip = view.querySelector<HTMLButtonElement>('.dshLiveTeamsAttention')
    await act(async () => { chip?.click() })
    await act(async () => { await Promise.resolve() })

    expect(open).toHaveBeenCalledWith('session-zed')
    const ack = calls.find((call) => call.url.includes('/messages/acknowledge'))
    expect(ack?.method).toBe('POST')
    expect(JSON.parse(ack?.body ?? '{}')).toMatchObject({ messageIds: ['msg-1', 'msg-2', 'msg-3'], sessionId: 'session-zed' })
    // The chip stops asking once the human has been taken to the source.
    expect(view.querySelector('.dshLiveTeamsAttention')).toBeNull()
  })

  /**
   * Clicking the chip navigates to the member's Session — and the chip lives in
   * the Session header, so the click can unmount the very instance that started
   * the acknowledgement. If the new instance re-asks while that request is still
   * in flight, the chip comes back and the human has to click twice. Reported
   * live: "нажал, перешёл в сессию Lead, затем нажал второй раз, чип пропал".
   */
  it('does not come back while its own acknowledgement is still in flight', async () => {
    let releaseAck = (): void => {}
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/attention')) return attentionPayload([entry])
      if (url.includes('/messages/acknowledge')) { await ackGate; return new Response(JSON.stringify({ messageIds: ['msg-1'], state: 'acknowledged' }), { status: 200, headers: { 'content-type': 'application/json' } }) }
      return inboxPayload([{ id: 'msg-1', from: 'z-live', fromName: 'Zed', kind: 'comment', content: 'a', createdAt: 1, delivery: { id: 'd-1', state: 'stored' } }])
    })
    const open = vi.fn()
    const first = await render({ sessions: sessionsService('session-old', open), t })
    await act(async () => { first.view.querySelector<HTMLButtonElement>('.dshLiveTeamsAttention')?.click() })
    expect(open).toHaveBeenCalledWith('session-zed')
    // The Session switch re-mounts the header: a fresh instance, same member waiting.
    await act(async () => { first.root.unmount() })
    const second = await render({ sessions: sessionsService('session-zed', open), t })
    await act(async () => { await Promise.resolve() })
    expect(second.view.querySelector('.dshLiveTeamsAttention')).toBeNull()
    releaseAck()
    await act(async () => { await Promise.resolve() })
  })

  it('keeps asking when the mailbox could not be cleared', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/attention')) return attentionPayload([entry])
      if (url.includes('/messages/acknowledge')) return new Response(JSON.stringify({ error: 'live-teams mutation failed' }), { status: 500, headers: { 'content-type': 'application/json' } })
      return inboxPayload([{ id: 'msg-1', from: 'z-live', fromName: 'Zed', kind: 'comment', content: 'a', createdAt: 1, delivery: { id: 'd-1', state: 'stored' } }])
    })
    const { view } = await render({ sessions: sessionsService('session-zed'), t })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsAttention')?.click() })
    await act(async () => { await Promise.resolve() })
    expect(await acknowledgeMemberWaiting('session-zed', 'z-live')).toBe(false)
    expect(view.querySelector('.dshLiveTeamsAttention')).not.toBeNull()
  })
})
