import * as React from 'react'
import { TeamView } from './TeamView.js'
import { PanelErrorBoundary } from './error-boundary.js'
import { Roster } from './roster.js'
import { AttentionChip, type SessionsService } from './attention.js'
import { dictionaries, NS, type LocaleKey } from './locales.js'
import { installLiveTeamsStyles } from './styles.js'

type LocaleService = {
  register(namespace: string, values: { readonly en: Record<string, string>; readonly ru: Record<string, string> }): () => void
  bind(namespace: string): (key: LocaleKey) => string
}

type SlotRegistration = {
  name: string
  id: string
  order: number
  locale: string
  label: () => string
}

type SlotsService = {
  inject(name: string, callback: () => unknown): unknown
  register(registration: SlotRegistration, component: (props: unknown) => React.ReactElement): unknown
}

type ClientContext = {
  slots: SlotsService
  locale: LocaleService
  sessions: SessionsService
  effect(effect: () => void | (() => void), name?: string): unknown
  /** Cordis throws when a service that was not declared in `inject` is read as a property. */
  get?(name: string): unknown
}

/**
 * Open a session, whichever way this host offers.
 *
 * DSH 0.1.7 removed `sessions.open` from the client service and opens sessions through
 * `uiWorkspace.openSession` instead; 0.1.5 has the opposite. Reading the new one through `ctx.get`
 * keeps the panel working on both without declaring a service the older host does not have — and a
 * host that offers neither gets told so, because a click that silently does nothing is what sent a
 * person looking for a bug in the wrong place.
 */
function sessionOpener(ctx: ClientContext): (sessionId: string) => boolean {
  const read = (name: string): Record<string, unknown> | undefined => {
    try {
      const value = ctx.get?.(name)
      return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
    } catch { return undefined }
  }
  return (sessionId: string): boolean => {
    const workspace = read('uiWorkspace')
    if (typeof workspace?.openSession === 'function') {
      (workspace.openSession as (id: string) => void).call(workspace, sessionId)
      return true
    }
    const legacy = (ctx.sessions ?? undefined) as { open?: (id: string) => void } | undefined
    if (typeof legacy?.open === 'function') { legacy.open(sessionId); return true }
    return false
  }
}

export const name = 'dsh-live-teams'
export const inject = ['slots', 'locale', 'sessions'] as const
export { NS } from './locales.js'

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const opener = sessionOpener(ctx)
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-live-teams: dictionaries')
  ctx.effect(installLiveTeamsStyles, 'dsh-live-teams: styles')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'live-teams-roster',
    order: 30,
    locale: NS,
    label: () => t('roster'),
  }, () => React.createElement(PanelErrorBoundary, { label: 'roster' }, React.createElement(Roster, {
    ctx: {
      sessions: ctx.sessions,
      t,
    },
  }))))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'live-teams-attention',
    order: 20,
    locale: NS,
    label: () => t('attention'),
  }, () => React.createElement(PanelErrorBoundary, { label: 'attention chip' }, React.createElement(AttentionChip, {
    ctx: {
      sessions: ctx.sessions,
      t,
    },
  }))))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'team',
    order: 30,
    locale: NS,
    label: () => t('tab'),
  }, (props: unknown): React.ReactElement => {
    const seat = (props ?? {}) as { sessionId?: string }
    return React.createElement(PanelErrorBoundary, { label: 'team panel' }, React.createElement(TeamView, {
      ...(seat.sessionId === undefined ? {} : { sessionId: seat.sessionId }),
      ctx: {
        sessions: ctx.sessions,
        openSession: opener,
        t,
      },
    }))
  }))
}

