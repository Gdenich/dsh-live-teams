import * as React from 'react'
import { TeamView } from './TeamView.js'
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
}

export const name = 'dsh-live-teams'
export const inject = ['slots', 'locale', 'sessions'] as const
export { NS } from './locales.js'

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-live-teams: dictionaries')
  ctx.effect(installLiveTeamsStyles, 'dsh-live-teams: styles')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'live-teams-roster',
    order: 30,
    locale: NS,
    label: () => t('roster'),
  }, () => React.createElement(Roster, {
    ctx: {
      sessions: ctx.sessions,
      t,
    },
  })))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'live-teams-attention',
    order: 20,
    locale: NS,
    label: () => t('attention'),
  }, () => React.createElement(AttentionChip, {
    ctx: {
      sessions: ctx.sessions,
      t,
    },
  })))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'team',
    order: 30,
    locale: NS,
    label: () => t('tab'),
  }, (props: unknown): React.ReactElement => {
    const seat = (props ?? {}) as { sessionId?: string }
    return React.createElement(TeamView, {
      ...(seat.sessionId === undefined ? {} : { sessionId: seat.sessionId }),
      ctx: {
        sessions: ctx.sessions,
        t,
      },
    })
  }))
}

