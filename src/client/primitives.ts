import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import React, { type ComponentType, type ReactNode } from 'react'
import { REQUIRED_PRIMITIVES } from './client-requirements.js'

/**
 * Host components, resolved by name at runtime with a working fallback.
 *
 * The icons were the first thing to break this way: the host renamed them, a named import became
 * `undefined`, and React took the whole Team tab down with "element type is invalid". The six
 * components below are imported the same way and carry the same risk — `Modal`, `Button`,
 * `MarkdownText`, `StateDot`, `Tag`, `Tooltip` are exactly as renameable as an icon.
 *
 * So they are resolved too. A missing component now degrades to something plain that still works —
 * a dialog that opens, a button that clicks, markdown shown as text — instead of a blank panel. The
 * fallbacks are deliberately dull: the point is that the human can still see the team and act.
 */
type AnyProps = Record<string, unknown>

const missing = (label: string) => (): React.ReactElement => React.createElement('span', { 'data-live-teams-fallback': label })

function resolveComponent(name: string, fallback: ComponentType<AnyProps>): ComponentType<AnyProps> {
  // A wrapper around the package may throw on an unknown name instead of returning `undefined`.
  try {
    const found = (primitives as unknown as Record<string, unknown>)[name]
    if (typeof found === 'function' || (typeof found === 'object' && found !== null)) return found as ComponentType<AnyProps>
  } catch { /* fall through to the fallback */ }
  return fallback
}

const ButtonFallback: ComponentType<AnyProps> = (props) => React.createElement('button', {
  type: 'button',
  className: props.className as string | undefined,
  onClick: props.onClick as (() => void) | undefined,
  disabled: props.disabled as boolean | undefined,
  'aria-label': props['aria-label'] as string | undefined,
  'data-live-teams-fallback': 'Button',
}, props.children as ReactNode)

const MarkdownFallback: ComponentType<AnyProps> = (props) => React.createElement('div', {
  className: props.className as string | undefined,
  'data-live-teams-fallback': 'MarkdownText',
}, String(props.text ?? ''))

const ModalFallback: ComponentType<AnyProps> = (props) => props.open === true
  ? React.createElement('div', { role: 'dialog', 'aria-label': props.title as string | undefined, 'data-live-teams-fallback': 'Modal' },
    props.description as ReactNode, props.children as ReactNode, props.footer as ReactNode)
  : null

const DotFallback: ComponentType<AnyProps> = (props) => React.createElement('span', { className: props.className as string | undefined, 'data-live-teams-fallback': 'StateDot' })
const TagFallback: ComponentType<AnyProps> = (props) => React.createElement('span', { className: props.className as string | undefined, 'data-live-teams-fallback': 'Tag' }, props.children as ReactNode)
const TooltipFallback: ComponentType<AnyProps> = (props) => React.createElement('span', { title: props.content as string | undefined, 'data-live-teams-fallback': 'Tooltip' }, props.children as ReactNode)

const FALLBACKS: Readonly<Record<string, ComponentType<AnyProps>>> = Object.freeze({
  Button: ButtonFallback,
  MarkdownText: MarkdownFallback,
  Modal: ModalFallback,
  StateDot: DotFallback,
  Tag: TagFallback,
  Tooltip: TooltipFallback,
})

const resolved: Record<string, ComponentType<AnyProps>> = {}
for (const name of REQUIRED_PRIMITIVES) {
  const fallback = FALLBACKS[name] ?? missing(name)
  resolved[name] = resolveComponent(name, fallback)
}

export const Button = resolved.Button as ComponentType<AnyProps>
export const MarkdownText = resolved.MarkdownText as ComponentType<AnyProps>
export const Modal = resolved.Modal as ComponentType<AnyProps>
export const StateDot = resolved.StateDot as ComponentType<AnyProps>
export const Tag = resolved.Tag as ComponentType<AnyProps>
export const Tooltip = resolved.Tooltip as ComponentType<AnyProps>

/** Which of them the host actually provided, for a check or a log line. */
export function resolvedFromHost(): readonly string[] {
  return REQUIRED_PRIMITIVES.filter((name) => {
    try { return (primitives as unknown as Record<string, unknown>)[name] !== undefined } catch { return false }
  })
}
