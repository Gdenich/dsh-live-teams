import { describe, expect, it } from 'vitest'
import { ICON_CANDIDATES } from './icon-names.js'

/**
 * The panel was empty on DSH 0.1.7-rc.1 because six icons it imported by name had been renamed. The
 * import was not an error at load time — it was `undefined` — and React threw "element type is
 * invalid" while rendering the whole tab.
 *
 * These two tests hold the fix in place: components ask for icons through the resolver, and the
 * resolver's candidate list knows the naming scheme the host uses now.
 */
describe('icons survive a rename', () => {
  it('asks for the name the host uses now, and keeps the old one as a fallback', () => {
    for (const [ours, candidates] of Object.entries(ICON_CANDIDATES)) {
      // Newest scheme first: the host's own components use the `Regular` stroke.
      expect(candidates[0], ours).toMatch(/OutlineRegular$/u)
      // And the name this plugin was written against stays reachable, so an older host still renders.
      expect(candidates.at(-1), ours).toMatch(/Outline(16|14)$/u)
    }
  })

})
