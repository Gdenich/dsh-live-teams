import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRoleDocument, readRoleRegistry } from './roles.js'

describe('role registry', () => {
  it('parses metadata, heading, aliases and permissions', () => {
    const role = parseRoleDocument('builder', '---\ndescription: Build things\ncapabilities: [implementation, refactoring]\npreferredTaskKinds: [implementation]\nrestrictions: [no scope]\naliases: [engineer]\npermissions:\n  workspaceWrite: true\n  canDelegate: false\n---\n\n# Builder\nCraft.')
    expect(role).toMatchObject({ id: 'builder', name: 'Builder', description: 'Build things', capabilities: ['implementation', 'refactoring'], aliases: ['engineer'], permissions: { workspaceWrite: true, canDelegate: false } })
  })
  it('falls back to id and tolerates broken front matter', () => {
    expect(parseRoleDocument('scout', 'plain body').name).toBe('scout')
    expect(parseRoleDocument('scout', '---\nbroken: [oops\n---\nplain body').name).toBe('scout')
  })
  it('handles missing directories and workspace precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-teams-roles-'))
    const global = join(root, 'global')
    const workspace = join(root, 'workspace')
    await mkdir(global)
    await mkdir(workspace)
    await writeFile(join(global, 'builder.md'), '# Global Builder\n')
    await writeFile(join(global, 'scout.md'), '# Scout\n')
    await writeFile(join(workspace, 'builder.md'), '# Local Builder\n')
    const registry = await readRoleRegistry(global, workspace)
    expect(registry.roles.map((role) => [role.id, role.name, role.source, role.overridden])).toEqual([['builder', 'Local Builder', 'workspace', true], ['scout', 'Scout', 'global', false]])
    expect((await readRoleRegistry(join(root, 'absent'), join(root, 'also-absent'))).roles).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})
