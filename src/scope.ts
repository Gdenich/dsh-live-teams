import path from 'node:path'

/**
 * Declared task scope: what a task says it may touch, and how two declarations are
 * compared. The comparison is deliberately conservative — it reports an overlap when
 * a declaration *could* collide, because a missed overlap costs somebody's edits while
 * a reported one costs throughput (B30).
 */

export const MAX_PATHS = 32

/**
 * Work that writes code, and therefore needs the isolation Gate C has not built yet
 * (ADR 0008; design §22), and the same set the parallel-write rules apply to. `work` is
 * listed because a generic kind does not promise it is documentation — the safe reading
 * of an unknown is "it writes", and the refusals name the kinds that are exempt.
 */
export const CODING_KINDS: ReadonlySet<string> = new Set(['implementation', 'repair', 'integration', 'work'])
const GLOB_CHARS = /[*?[\]{}!()]/

/**
 * Paths that every task effectively shares, so touching one collides with any active
 * writer: manifests and lockfiles, repository internals, CI configuration and build
 * entry points. The deployment may extend this list with `sharedPaths`.
 */
export const SHARED_PATH_DEFAULTS: readonly string[] = Object.freeze([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  '.git/**',
  '.github/**',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Makefile',
])

/** Normalise one entry, or refuse it. Returns undefined for an unusable value. */
export function normalizeScopePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 512) return undefined
  // A Windows-style separator would otherwise leave a prefix like `a\b` that never
  // matches the POSIX paths the rest of the plugin stores.
  const slashed = trimmed.replace(/\\/gu, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/u.test(slashed)) return undefined
  const segments = slashed.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return undefined
  // `..` would let a declaration point outside the workspace, which is not a scope
  // this product can honour.
  if (segments.some((segment) => segment === '..')) return undefined
  return segments.join('/')
}

/** Normalise a whole declaration; undefined when any entry is unusable, or on duplicates. */
export function normalizeScope(paths: unknown): string[] | undefined {
  if (!Array.isArray(paths)) return undefined
  if (paths.length === 0 || paths.length > MAX_PATHS) return undefined
  const normalized: string[] = []
  for (const entry of paths) {
    const value = normalizeScopePath(entry)
    if (value === undefined) return undefined
    if (normalized.includes(value)) return undefined
    normalized.push(value)
  }
  return normalized
}

/**
 * The literal prefix a pattern can be reduced to: everything before the first segment
 * that contains a wildcard. `src/**\/*.ts` reduces to `src`, `a/b*` to `a`.
 */
export function literalPrefix(entry: string): string {
  const segments = entry.split('/')
  const first = segments.findIndex((segment) => GLOB_CHARS.test(segment))
  return (first < 0 ? segments : segments.slice(0, first)).join('/')
}

/**
 * True when the two entries could touch the same file. Segment-boundary prefixes only,
 * so `a/b` and `a/bc` stay apart; a wildcard reduces to its literal prefix, which makes
 * this report overlaps that a particular run would not have produced.
 */
export function scopesIntersect(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) return true
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

export type ScopeOverlap = { left: string; right: string; shared: boolean }
export type ScopeConflict =
  | { kind: 'overlap'; left: string; right: string }
  | { kind: 'shared'; left: string; right: string }

/**
 * Compare two declarations. Shared hotspots are reported separately from concrete
 * overlaps: the lead's action differs — one is "narrow the scope or serialise the two
 * tasks", the other is "these files are shared by everything".
 */
export function scopeConflict(left: readonly string[], right: readonly string[], shared: readonly string[] = SHARED_PATH_DEFAULTS): ScopeConflict | undefined {
  const reduce = (entry: string): string => literalPrefix(entry)
  const overlaps = (entry: string, other: string): boolean => scopesIntersect(reduce(entry), reduce(other))
  let sharedHit: ScopeConflict | undefined
  for (const a of left) {
    for (const b of right) {
      if (!overlaps(a, b)) continue
      const hotspot = shared.some((candidate) => overlaps(a, candidate) || overlaps(b, candidate))
      if (!hotspot) return { kind: 'overlap', left: a, right: b }
      sharedHit ??= { kind: 'shared', left: a, right: b }
    }
  }
  return sharedHit
}

/** Changed paths that fall outside a declaration. */
export function outsideScope(changed: readonly string[], declared: readonly string[]): string[] {
  return changed.filter((candidate) => {
    const normalized = normalizeScopePath(candidate)
    if (normalized === undefined) return false
    return !declared.some((entry) => scopesIntersect(literalPrefix(entry), normalized))
  })
}

/** Two declarations that a reviewer can compare without re-reading the contract. */
export function scopeSummary(paths: readonly string[] | undefined): string {
  return paths === undefined || paths.length === 0 ? 'not declared' : paths.join(', ')
}

export function resolveWorkspacePath(workspacePath: string, entry: string): string {
  return path.join(workspacePath, ...entry.split('/'))
}
