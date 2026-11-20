import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A check that uses a symbol it never imported crashes with "symlink is not defined" — a message
 * that says nothing about what the check was verifying, and only when that check happens to run.
 *
 * This happened while rolling a fix across thirty-seven scripts: four of them used `symlink` or
 * `readdir` without importing it. The composition checks are not part of the unit suite, so nothing
 * would have caught it until someone ran them.
 */
const FS_SYMBOLS = ['symlink', 'dirname', 'readdir', 'mkdir', 'writeFile', 'rm', 'mkdtemp', 'readFile', 'tmpdir', 'join'] as const
const LOCAL_SYMBOLS = ['loadBundlePatches', 'classifyResult'] as const

describe('composition checks import what they use', () => {
  it('has no script calling a symbol it did not import', async () => {
    const directory = path.join(import.meta.dirname, '..', 'scripts')
    const offenders: string[] = []
    for (const name of (await readdir(directory)).filter((entry) => entry.endsWith('.mjs'))) {
      const source = await readFile(path.join(directory, name), 'utf8')
      const imports = (source.match(/import[^;]*?from\s*'[^']+'/gs) ?? []).join(' ')
      const imported = (symbol: string): boolean => new RegExp(`[{,\\s]${symbol}[,\\s}]`, 'u').test(imports)
      const called = (symbol: string): boolean => new RegExp(`(?<![\\w.$])${symbol}\\(`, 'u').test(source)
      for (const symbol of FS_SYMBOLS) {
        if (called(symbol) && !imported(symbol)) offenders.push(`${name}: ${symbol}`)
      }
      for (const symbol of LOCAL_SYMBOLS) {
        // The two helper modules define these; every other script must import them.
        if (source.includes(`export function ${symbol}`)) continue
        if (called(symbol) && !imported(symbol)) offenders.push(`${name}: ${symbol}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
