import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_PRIMITIVES } from './client-requirements.js'

/**
 * The declared requirement must be the real one.
 *
 * `REQUIRED_PRIMITIVES` is what the host-facing check verifies against an installed DSH, so a
 * component added to the panel without being declared here would be checked by nobody — and a
 * renamed component would blank the tab exactly as the renamed icons did.
 */
describe('the panel declares what it imports', () => {
  it('reaches the host package only through the resolvers', async () => {
    // A direct named import of a host component or icon is what broke the tab: it cannot degrade,
    // only crash the slot. Everything goes through primitives.ts or icons.ts, which have fallbacks.
    const directory = import.meta.dirname
    const allowed = new Set(['primitives.ts', 'icons.ts', 'client-requirements.test.ts'])
    const offenders: string[] = []
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      if (allowed.has(name) || name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue
      const source = await readFile(path.join(directory, name), 'utf8')
      for (const line of source.split('\n')) {
        if (line.includes('@deepseek-ai/dsh-client-ui-primitives')) offenders.push(`${name}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the declared list in step with the resolver', async () => {
    // The resolver iterates the same list the host-facing check verifies, so a component added to
    // one and not the other is impossible by construction.
    const source = await readFile(path.join(import.meta.dirname, 'primitives.ts'), 'utf8')
    expect(source).toContain('for (const name of REQUIRED_PRIMITIVES)')
    for (const name of REQUIRED_PRIMITIVES) expect(source).toContain(`export const ${name} =`)
  })
})
