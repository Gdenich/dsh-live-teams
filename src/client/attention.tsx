/**
 * The attention chip.
 *
 * The Messages panel answered "what was said to me", which is a question nobody
 * asks — the human asks "does anyone need me?", and then wants the conversation,
 * which lives in the member's own Session. This chip answers that question from
 * anywhere: it sits in the Session header, resolves the team from the Session it
 * is rendered in, and a click opens the member who is waiting.
 *
 * Acknowledging on click is deliberate: the delivery record is the only durable
 * "the human was told" evidence, and opening the source is the human acting on
 * it. Without that the chip would keep asking forever.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { acknowledgeTeamMessages, fetchTeamAttention, fetchTeamInbox, type TeamAttentionEntry } from './api.js'
import type { LocaleKey } from './locales.js'
import './styles.js'

export type SessionsService = {
  readonly open: (sessionId: string) => void
  readonly list?: {
    readonly getSnapshot: () => { readonly current?: string }
    readonly subscribe?: (listener: () => void) => () => void
  }
}

export type AttentionContext = {
  readonly sessions: SessionsService
  readonly t: (key: LocaleKey) => string
}

export type AttentionChipProps = { readonly ctx?: AttentionContext }

/** How often the chip re-asks while a Session is open. */
export const ATTENTION_POLL_MS = 20000

/**
 * How long a started acknowledgement may suppress a member before the chip
 * stops trusting the attempt and asks the mailbox again.
 */
export const PENDING_CLEAR_TTL_MS = 15000

/**
 * Members whose acknowledgement is in flight.
 *
 * Clicking the chip opens the member's Session, and the chip lives in the Session
 * header — so the click can unmount the instance that started the acknowledgement,
 * and the Session switch mounts a fresh one. With only local state, that new
 * instance re-asks before the request lands, sees the member still waiting, and
 * puts the chip back: one click to travel, a second to clear. Reported live:
 * "нажал, перешёл в сессию Lead, затем нажал второй раз, чип пропал".
 *
 * The marker is dropped as soon as the request settles, so a failure brings the
 * chip back instead of hiding a backlog the human was never told about. The TTL
 * only bounds a request that never settles at all.
 */
const pendingClears = new Map<string, number>()

export function isClearPending(memberId: string, now: number = Date.now()): boolean {
  const startedAt = pendingClears.get(memberId)
  if (startedAt === undefined) return false
  if (now - startedAt > PENDING_CLEAR_TTL_MS) { pendingClears.delete(memberId); return false }
  return true
}

/** Test seam: the marker is module state, so a test file must be able to reset it. */
export function resetAttentionClears(): void { pendingClears.clear() }

/**
 * The Session the chip speaks for: the one being viewed, not the one it happens
 * to be mounted in. The `conversation.session.header.utilities` slot passes no
 * props (`renderSlot(name, {})`), so this is the only way to the Session id.
 */
export function currentSessionId(sessions: SessionsService | undefined): string | undefined {
  const current = sessions?.list?.getSnapshot().current
  return typeof current === 'string' && current.length > 0 ? current : undefined
}

/** What the chip says: the longest-waiting member, plus how many others follow. */
export function attentionLabel(entries: readonly TeamAttentionEntry[]): { name: string; extra: number; waiting: number } | undefined {
  const first = entries[0]
  if (first === undefined) return undefined
  return { name: first.name, extra: entries.length - 1, waiting: first.waiting }
}

/**
 * Mark everything one member is waiting on as read by the human.
 *
 * The waiting count comes from deliveries, whose ids only the inbox carries, so
 * this reads the inbox once and acknowledges in a single request. Returns false
 * when the state could not be cleared, so the chip can keep asking instead of
 * pretending the human saw something they did not.
 */
export async function acknowledgeMemberWaiting(sessionId: string, memberId: string): Promise<boolean> {
  try {
    const inbox = await fetchTeamInbox(sessionId, 200)
    const ids = inbox.messages
      .filter((message) => message.from === memberId && message.delivery.state === 'stored')
      .map((message) => message.id)
    if (ids.length === 0) return true
    await acknowledgeTeamMessages(ids, sessionId)
    return true
  } catch { return false }
}

export function AttentionChip(props: AttentionChipProps): React.ReactElement | null {
  const ctx = props.ctx
  const t = ctx?.t ?? ((key: LocaleKey) => key)
  const [sessionId, setSessionId] = useState<string | undefined>(() => currentSessionId(ctx?.sessions))
  const [entries, setEntries] = useState<TeamAttentionEntry[]>([])
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const list = ctx?.sessions.list
    if (list?.subscribe === undefined) return undefined
    setSessionId(currentSessionId(ctx?.sessions))
    return list.subscribe(() => setSessionId(currentSessionId(ctx?.sessions)))
  }, [ctx?.sessions])

  const refresh = useCallback((signal?: AbortSignal) => {
    if (sessionId === undefined) { setEntries([]); return }
    void fetchTeamAttention(sessionId, signal)
      // A member whose acknowledgement is in flight is not "still waiting": the
      // human has already acted, and the mailbox is about to agree.
      .then((result) => { if (signal?.aborted !== true && mounted.current) setEntries(result.attention.filter((entry) => !isClearPending(entry.memberId))) })
      .catch(() => { if (signal?.aborted !== true && mounted.current) setEntries([]) })
  }, [sessionId])

  useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal)
    const timer = setInterval(() => refresh(controller.signal), ATTENTION_POLL_MS)
    const onFocus = (): void => refresh(controller.signal)
    window.addEventListener('focus', onFocus)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refresh])

  const label = attentionLabel(entries)
  if (label === undefined || sessionId === undefined) return null

  const open = (): void => {
    const first = entries[0]
    if (first === undefined || busy) return
    setBusy(true)
    // Marked before travelling: the instance that finishes this request may not be
    // the instance that mounted this button.
    pendingClears.set(first.memberId, Date.now())
    if (first.sessionId !== null) ctx?.sessions.open(first.sessionId)
    void acknowledgeMemberWaiting(sessionId, first.memberId).then((cleared) => {
      pendingClears.delete(first.memberId)
      if (!mounted.current) return
      // Clearing is a fact only when the mailbox said so; otherwise keep the chip
      // and re-ask, because a person who was told nothing must not be told so.
      if (cleared) setEntries((current) => current.filter((entry) => entry.memberId !== first.memberId))
      else refresh()
    }).finally(() => { if (mounted.current) setBusy(false) })
  }

  return <button
    type="button"
    className={`dshLiveTeamsAttention${busy ? ' dshLiveTeamsAttentionBusy' : ''}`}
    onClick={open}
    disabled={busy}
    aria-label={`${label.name} — ${t('attentionWaiting')}`}
    title={t('attentionWaiting')}
  >
    <span className="dshLiveTeamsAttentionDot" aria-hidden="true">●</span>
    <span className="dshLiveTeamsAttentionName">{label.name}</span>
    {label.extra > 0 && <span className="dshLiveTeamsAttentionMore">{`+${label.extra}`}</span>}
    {label.waiting > 1 && <span className="dshLiveTeamsAttentionCount">{label.waiting}</span>}
  </button>
}
