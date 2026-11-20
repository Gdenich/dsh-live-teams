import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnosePaths } from './path-diagnostics.js'

const roots: string[] = []
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'live-teams-paths-'))
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('advisory path diagnostics', () => {
  it('recognizes existing files, directories and real glob matches', async () => {
    const root = await workspace()
    await mkdir(join(root, 'backend', 'migrations'), { recursive: true })
    await writeFile(join(root, 'backend', 'migrations', 'a.py'), '')
    expect(await diagnosePaths(root, ['backend', 'backend/migrations', 'backend/**/*.py', 'backend/**/a.?y', 'backend/**/{a,b}.py'])).toEqual([])
  })

  it('warns when a valid new path or glob does not exist, without mistaking a prefix for a match', async () => {
    const root = await workspace()
    await mkdir(join(root, 'backend'))
    await writeFile(join(root, 'backend', 'a.ts'), '')
    expect(await diagnosePaths(root, ['backend/alembic/**', 'backend/**/*.py', 'new.txt'])).toMatchObject([
      { code: 'path-no-match', pattern: 'backend/alembic/**' },
      { code: 'path-no-match', pattern: 'backend/**/*.py' },
      { code: 'path-no-match', pattern: 'new.txt' },
    ])
  })

  it('reports an incomplete scan honestly when the entry bound is reached', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), '')
    expect(await diagnosePaths(root, ['missing/**'], { maxEntries: 0 })).toMatchObject([{ code: 'path-scan-incomplete' }])
  })

  it('does not follow a symlink outside the workspace or claim its descendants do not exist', async () => {
    const root = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, 'private.txt'), '')
    await symlink(outside, join(root, 'linked'))
    expect(await diagnosePaths(root, ['linked/private.txt'])).toMatchObject([{ code: 'path-scan-incomplete' }])
    expect(await diagnosePaths(root, ['unrelated/**'])).toMatchObject([{ code: 'path-no-match' }])
  })

  it('distinguishes unavailable inspection from no matches', async () => {
    const root = await workspace()
    expect(await diagnosePaths(join(root, 'gone'), ['src/**'])).toMatchObject([{ code: 'path-scan-incomplete' }])
  })

  it('refuses unsafe patterns at its boundary and skips inspection without declarations', async () => {
    const root = await workspace()
    await expect(diagnosePaths(root, ['../outside/**'])).rejects.toThrow('safe workspace-relative')
    expect(await diagnosePaths(root, undefined)).toEqual([])
  })
})
