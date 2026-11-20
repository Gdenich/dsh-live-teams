import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitCommittedPaths } from './changed-paths.js'

/**
 * `git status` shows uncommitted work only, so a member that commits its work looked like it had
 * changed nothing. This reads what it committed since the attempt took its base — the other half of
 * the changed set.
 */
describe('committed paths', () => {
  it('reports the files a member committed on its own branch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'live-teams-committed-'))
    try {
      const git = (args: string[]): string => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' })
      await mkdir(join(workspace, 'src'), { recursive: true })
      await writeFile(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
      git(['init', '-q', '-b', 'main', '.'])
      git(['add', '-A'])
      git(['-c', 'user.email=b@check', '-c', 'user.name=base', 'commit', '-qm', 'base'])
      const base = git(['rev-parse', 'HEAD']).trim()

      expect(await gitCommittedPaths(workspace, base)).toEqual([])

      git(['checkout', '-q', '-b', 'task/work'])
      await writeFile(join(workspace, 'src', 'a.ts'), 'export const a = 2\n')
      await writeFile(join(workspace, 'src', 'b.ts'), 'export const b = 1\n')
      git(['add', '-A'])
      git(['-c', 'user.email=w@check', '-c', 'user.name=worker', 'commit', '-qm', 'work'])

      const committed = await gitCommittedPaths(workspace, base)
      expect(committed?.sort()).toEqual(['src/a.ts', 'src/b.ts'])

      // A base that does not exist is unreadable, never "nothing changed".
      expect(await gitCommittedPaths(workspace, '0000000000000000000000000000000000000000')).toBeUndefined()
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
