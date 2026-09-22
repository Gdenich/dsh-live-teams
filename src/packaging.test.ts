import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The runtime reads these directories relative to the installed package. A
 * directory that is not declared in `files` is not copied by a package install,
 * so the feature silently ships empty — visible only in a real installation.
 */
const REQUIRED_RUNTIME_DIRECTORIES = ['roles']

describe('package payload', () => {
  it('declares every runtime directory the plugin reads', () => {
    const payload = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files?: string[] }
    const declared = payload.files ?? []
    for (const directory of REQUIRED_RUNTIME_DIRECTORIES) {
      expect(declared.some((entry) => entry === directory || entry.startsWith(`${directory}/`))).toBe(true)
    }
  })

  it('ships at least one role file in the global registry', () => {
    const directory = join(packageRoot, 'roles')
    expect(existsSync(directory)).toBe(true)
    expect(readdirSync(directory).filter((entry) => entry.endsWith('.md')).length).toBeGreaterThan(0)
  })
})
