import { promises as fs, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export type RolePermissions = {
  readonly workspaceWrite?: boolean
  readonly canDelegate?: boolean
  readonly [key: string]: boolean | undefined
}

export type LiveTeamsRole = {
  readonly id: string
  readonly name: string
  readonly body: string
  readonly description?: string
  readonly capabilities: readonly string[]
  readonly preferredTaskKinds: readonly string[]
  readonly restrictions: readonly string[]
  readonly aliases: readonly string[]
  readonly permissions: RolePermissions
  readonly source: 'global' | 'workspace'
  readonly overridden: boolean
  readonly filePath: string
}

export type ParsedRole = Omit<LiveTeamsRole, 'source' | 'overridden'>
export type RoleRegistrySync = Pick<RoleRegistry, 'resolve'>

export type RoleRegistry = {
  readonly roles: readonly LiveTeamsRole[]
  readonly globalRoleIds: ReadonlySet<string>
  readonly globalRolePath: (id: string) => string | undefined
  readonly globalDirectory: string
  readonly workspaceDirectory: string
  readonly workspaceDirectoryExists: boolean
  readonly resolve: (value: string) => LiveTeamsRole | undefined
}

type FrontMatter = {
  description?: string
  capabilities?: string[]
  preferredTaskKinds?: string[]
  restrictions?: string[]
  aliases?: string[]
  permissions?: RolePermissions
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function scalar(value: string): string | boolean | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return trimmed
}

function scalarList(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const inner = trimmed.slice(1, -1).trim()
  if (inner.length === 0) return []
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (const character of inner) {
    if (quote !== undefined) {
      current += character
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      quote = character
      current += character
    } else if (character === ',') {
      const item = scalar(current)
      if (typeof item !== 'string') return undefined
      parts.push(item)
      current = ''
    } else current += character
  }
  if (quote !== undefined) return undefined
  const item = scalar(current)
  if (typeof item !== 'string') return undefined
  parts.push(item)
  return parts
}

/** Parse the deliberately small, YAML-like role metadata format without executing YAML. */
function parseFrontMatter(lines: readonly string[]): FrontMatter | undefined {
  const result: FrontMatter = {}
  const permissions: Record<string, boolean> = {}
  let inPermissions = false
  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const match = /^(\s*)([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line)
    if (match === null) return undefined
    const indent = match[1]?.length ?? 0
    const key = match[2]
    const raw = match[3] ?? ''
    if (key === undefined) return undefined
    if (indent > 0 && inPermissions) {
      const value = scalar(raw)
      if (typeof value !== 'boolean') return undefined
      permissions[key] = value
      continue
    }
    inPermissions = false
    if (key === 'permissions') {
      if (raw.trim().length > 0) return undefined
      inPermissions = true
      continue
    }
    const list = scalarList(raw)
    const value = scalar(raw)
    if (key === 'description') {
      if (typeof value !== 'string') return undefined
      result.description = value
    } else if (key === 'capabilities') {
      if (list === undefined) return undefined
      result.capabilities = list
    } else if (key === 'preferredTaskKinds') {
      if (list === undefined) return undefined
      result.preferredTaskKinds = list
    } else if (key === 'restrictions') {
      if (list !== undefined) result.restrictions = list
      else if (typeof value === 'string') result.restrictions = [value]
      else return undefined
    } else if (key === 'aliases') {
      if (list === undefined) return undefined
      result.aliases = list
    }
  }
  if (Object.keys(permissions).length > 0) result.permissions = permissions
  return result
}

function splitRoleDocument(contents: string): { metadata: FrontMatter | undefined; body: string } {
  const normalized = contents.replace(/^\uFEFF/u, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return { metadata: undefined, body: normalized }
  const lines = normalized.split(/\r?\n/u)
  if (lines[0] !== '---') return { metadata: undefined, body: normalized }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing < 0) return { metadata: undefined, body: normalized }
  const metadata = parseFrontMatter(lines.slice(1, closing))
  if (metadata === undefined) return { metadata: undefined, body: normalized }
  return { metadata, body: lines.slice(closing + 1).join('\n') }
}

function firstHeading(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/u)) {
    const match = /^#\s+(.+?)\s*#*\s*$/u.exec(line)
    if (match?.[1] !== undefined && match[1].trim().length > 0) return match[1].trim()
  }
  return fallback
}

function roleId(file: string): string | undefined {
  const basename = path.basename(file)
  if (!basename.endsWith('.md')) return undefined
  const id = basename.slice(0, -3)
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) ? id : undefined
}

async function readRole(file: string, source: 'global' | 'workspace', overridden: boolean): Promise<LiveTeamsRole | undefined> {
  const id = roleId(file)
  if (id === undefined) return undefined
  let contents: string
  try { contents = await fs.readFile(file, 'utf8') } catch { return undefined }
  const document = splitRoleDocument(contents)
  const metadata = document.metadata ?? {}
  return {
    id,
    name: firstHeading(document.body, id),
    body: document.body.trim(),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    capabilities: metadata.capabilities ?? [],
    preferredTaskKinds: metadata.preferredTaskKinds ?? [],
    restrictions: metadata.restrictions ?? [],
    aliases: metadata.aliases ?? [],
    permissions: metadata.permissions ?? {},
    source,
    overridden,
    filePath: path.resolve(file),
  }
}

async function readDirectory(directory: string, source: 'global' | 'workspace', overriddenIds: ReadonlySet<string>): Promise<LiveTeamsRole[]> {
  let entries: string[]
  try { entries = await fs.readdir(directory) } catch (error) {
    if (record(error).code === 'ENOENT') return []
    return []
  }
  const roles: LiveTeamsRole[] = []
  for (const entry of entries.sort()) {
    const role = await readRole(path.join(directory, entry), source, source === 'workspace' && overriddenIds.has(entry.slice(0, -3)))
    if (role !== undefined) roles.push(role)
  }
  return roles
}

function readDirectorySync(directory: string, source: 'global' | 'workspace', overriddenIds: ReadonlySet<string>): LiveTeamsRole[] {
  let entries: string[]
  try { entries = readdirSync(directory) } catch { return [] }
  const roles: LiveTeamsRole[] = []
  for (const entry of entries.sort()) {
    const file = path.join(directory, entry)
    const id = roleId(file)
    if (id === undefined) continue
    let contents: string
    try { contents = readFileSync(file, 'utf8') } catch { continue }
    const document = splitRoleDocument(contents)
    const metadata = document.metadata ?? {}
    roles.push({ id, name: firstHeading(document.body, id), body: document.body.trim(), ...(metadata.description === undefined ? {} : { description: metadata.description }), capabilities: metadata.capabilities ?? [], preferredTaskKinds: metadata.preferredTaskKinds ?? [], restrictions: metadata.restrictions ?? [], aliases: metadata.aliases ?? [], permissions: metadata.permissions ?? {}, source, overridden: source === 'workspace' && overriddenIds.has(id), filePath: path.resolve(file) })
  }
  return roles
}

export function readRoleRegistrySync(globalDirectory: string, workspaceDirectory: string): RoleRegistry {
  const globalPath = path.resolve(globalDirectory)
  const workspacePath = path.resolve(workspaceDirectory)
  const globalRoles = readDirectorySync(globalPath, 'global', new Set())
  const globalIds = new Set(globalRoles.map((role) => role.id))
  const workspaceRoles = readDirectorySync(workspacePath, 'workspace', globalIds)
  const workspaceIds = new Set(workspaceRoles.map((role) => role.id))
  const roles = [...globalRoles.filter((role) => !workspaceIds.has(role.id)), ...workspaceRoles].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  const byIdentifier = new Map<string, LiveTeamsRole>()
  for (const role of roles) { byIdentifier.set(role.id, role); for (const alias of role.aliases) if (!byIdentifier.has(alias)) byIdentifier.set(alias, role) }
  const globalPaths = new Map(globalRoles.map((role) => [role.id, role.filePath]))
  let workspaceDirectoryExists = false
  try { workspaceDirectoryExists = statSync(workspacePath).isDirectory() } catch { workspaceDirectoryExists = false }
  return { roles, globalRoleIds: globalIds, globalRolePath: (id) => globalPaths.get(id), globalDirectory: globalPath, workspaceDirectory: workspacePath, workspaceDirectoryExists, resolve: (value) => byIdentifier.get(value) }
}

export async function readRoleRegistry(globalDirectory: string, workspaceDirectory: string): Promise<RoleRegistry> {
  const globalPath = path.resolve(globalDirectory)
  const workspacePath = path.resolve(workspaceDirectory)
  const globalRoles = await readDirectory(globalPath, 'global', new Set())
  const globalIds = new Set(globalRoles.map((role) => role.id))
  const workspaceRoles = await readDirectory(workspacePath, 'workspace', globalIds)
  const workspaceIds = new Set(workspaceRoles.map((role) => role.id))
  const roles = [...globalRoles.filter((role) => !workspaceIds.has(role.id)), ...workspaceRoles]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  const byIdentifier = new Map<string, LiveTeamsRole>()
  for (const role of roles) {
    byIdentifier.set(role.id, role)
    for (const alias of role.aliases) if (!byIdentifier.has(alias)) byIdentifier.set(alias, role)
  }
  let workspaceDirectoryExists = false
  try { workspaceDirectoryExists = (await fs.stat(workspacePath)).isDirectory() } catch { workspaceDirectoryExists = false }
  const globalPaths = new Map(globalRoles.map((role) => [role.id, role.filePath]))
  return { roles, globalRoleIds: globalIds, globalRolePath: (id) => globalPaths.get(id), globalDirectory: globalPath, workspaceDirectory: workspacePath, workspaceDirectoryExists, resolve: (value) => byIdentifier.get(value) }
}

export function parseRoleDocument(id: string, contents: string, filePath = id): ParsedRole {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new Error('invalid role id')
  const document = splitRoleDocument(contents)
  const metadata = document.metadata ?? {}
  return {
    id,
    name: firstHeading(document.body, id),
    body: document.body.trim(),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    capabilities: metadata.capabilities ?? [],
    preferredTaskKinds: metadata.preferredTaskKinds ?? [],
    restrictions: metadata.restrictions ?? [],
    aliases: metadata.aliases ?? [],
    permissions: metadata.permissions ?? {},
    filePath: path.resolve(filePath),
  }
}
