import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType, ReactElement } from 'react'
import { ICON_CANDIDATES } from './icon-names.js'

/**
 * Icons, resolved by name at runtime instead of imported by name at build time.
 *
 * The host renamed every icon between 0.1.5-rc.2 and 0.1.7-rc.1: `IconEditOutline16` became
 * `IconEditOutlineRegular` (stroke 1, what the host itself uses) or `IconEditOutlineMedium`
 * (stroke 1.3). A named import of a name that no longer exists is not an error at load time — it is
 * `undefined` — and React then throws "element type is invalid" (error #130) while rendering the
 * whole panel. That is exactly what happened: the Team tab was empty, and the host log said
 * `slot entry crashed in 'conversation.view'` with nothing about icons.
 *
 * So each icon is looked up by a list of names, newest first, and an icon that cannot be found
 * renders nothing. One renamed icon costs one icon, never the panel.
 */
type IconProps = { size?: number; className?: string }
type IconComponent = ComponentType<IconProps>

const Missing: IconComponent = () => null as unknown as ReactElement

function resolveIcon(candidates: readonly string[]): IconComponent {
  for (const name of candidates) {
    // A host that wraps the package may throw on an unknown name instead of returning `undefined`
    // (a test double does). Either way the answer is the same: use the fallback.
    try {
      const found = (primitives as unknown as Record<string, unknown>)[name]
      if (typeof found === 'function' || (typeof found === 'object' && found !== null)) return found as IconComponent
    } catch { /* fall through to the next candidate */ }
  }
  return Missing
}

/** Newest naming scheme first, then the one this plugin was written against. */
export const IconEdit = resolveIcon(ICON_CANDIDATES.IconEdit as readonly string[])
export const IconPlus = resolveIcon(ICON_CANDIDATES.IconPlus as readonly string[])
export const IconPause = resolveIcon(ICON_CANDIDATES.IconPause as readonly string[])
export const IconPlay = resolveIcon(ICON_CANDIDATES.IconPlay as readonly string[])
export const IconRefresh = resolveIcon(ICON_CANDIDATES.IconRefresh as readonly string[])
export const IconChevronDown = resolveIcon(ICON_CANDIDATES.IconChevronDown as readonly string[])
