import { opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { literalPrefix, normalizeScope, scopesIntersect } from './scope.js'

export type PathWarning = { code: 'path-no-match' | 'path-scan-incomplete'; pattern: string; message: string }

/** Advisory only. Never follows symlinks, executes commands, or makes a contract invalid. */
export async function diagnosePaths(workspace: string, declared: readonly string[] | undefined, options: { maxEntries?: number; maxMillis?: number } = {}): Promise<PathWarning[]> {
  if (declared === undefined || declared.length === 0) return []
  const patterns = normalizeScope([...declared])
  if (patterns === undefined) throw new Error('path diagnostics require normalized safe workspace-relative patterns')
  const matched = new Set<string>()
  const uncertain: string[] = []
  let exhausted = false
  let visited = 0
  const limit = options.maxEntries ?? 5000
  const deadline = Date.now() + (options.maxMillis ?? 1000)
  let root: string
  try { root = await realpath(workspace) } catch {
    return patterns.map((pattern) => ({ code: 'path-scan-incomplete', pattern, message: `Could not inspect declared path "${pattern}"; workspace inspection was unavailable.` }))
  }
  const queue = ['']
  for (let index = 0; index < queue.length && matched.size < patterns.length; index += 1) {
    const relativeDirectory = queue[index]!
    if (Date.now() > deadline) { exhausted = true; break }
    try {
      const absolute = path.join(root, relativeDirectory)
      const resolved = await realpath(absolute)
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) { uncertain.push(relativeDirectory); continue }
      const directory = await opendir(absolute)
      for await (const entry of directory) {
        if (++visited > limit || Date.now() > deadline) { exhausted = true; break }
        const relative = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`
        for (const pattern of patterns) {
          try {
            if (path.matchesGlob(relative, pattern) || (entry.isDirectory() && path.matchesGlob(`${relative}/`, pattern))) matched.add(pattern)
          } catch { uncertain.push(literalPrefix(pattern)) }
        }
        if (entry.isSymbolicLink()) { uncertain.push(relative); continue }
        if (!entry.isDirectory()) continue
        if (relative === '.git' || relative === '.dsh-live-teams' || relative.split('/').length > 32) { uncertain.push(relative); continue }
        // Only descend into subtrees that can contain one of the requested patterns.
        if (patterns.some((pattern) => !matched.has(pattern) && scopesIntersect(relative, literalPrefix(pattern)))) queue.push(relative)
      }
      if (exhausted) break
    } catch { uncertain.push(relativeDirectory) }
  }
  return patterns.filter((pattern) => !matched.has(pattern)).map((pattern) => {
    const incomplete = exhausted || uncertain.some((prefix) => scopesIntersect(prefix, literalPrefix(pattern)))
    return incomplete
      ? { code: 'path-scan-incomplete', pattern, message: `Could not establish whether "${pattern}" matches existing paths; inspection was incomplete.` }
      : { code: 'path-no-match', pattern, message: `Declared path "${pattern}" matches no existing file or directory. Confirm that this is a new path rather than a typo.` }
  })
}
