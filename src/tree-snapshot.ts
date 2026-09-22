import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/**
 * A cheap fingerprint of a workspace tree, for the scope record in `files` mode (B32).
 *
 * Pure filesystem work — no git, no shelling out — so the task store can use it without
 * taking on the git adapter, and so it can be tested against a plain temporary folder.
 * Size and mtime, not content: the question is whether a file moved while an attempt ran,
 * and hashing every file of a workspace on every claim is a cost nobody agreed to. Content
 * digests live in the submission artifact, where they belong.
 */

/** Directories that are never a member's work: build output, caches, the team's own state. */
export const SNAPSHOT_EXCLUDED = new Set(['.git', '.dsh-live-teams', 'node_modules', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage', '.idea', '.DS_Store'])

export const MAX_SNAPSHOT_FILES = 20000

export type TreeSnapshot = Readonly<Record<string, string>>

/**
 * A cheap fingerprint of the whole tree: path → `size:mtime`.
 *
 * Size and mtime, not content: the question here is "did this file move while the attempt
 * ran", and hashing every file of a workspace on every claim would be a cost nobody agreed
 * to. Content digests live in the submission artifact, where they belong.
 *
 * `undefined` means the tree was too large to watch, which is reported as `unchecked` with a
 * reason rather than as "nothing changed".
 */
export async function snapshotTree(workspacePath: string): Promise<TreeSnapshot | undefined> {
  const snapshot: Record<string, string> = {}
  let count = 0
  const walk = async (relative: string): Promise<boolean> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(path.join(workspacePath, relative), { withFileTypes: true })
    } catch { return true }
    for (const entry of entries) {
      const next = relative.length === 0 ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (SNAPSHOT_EXCLUDED.has(entry.name)) continue
        if (!(await walk(next))) return false
        continue
      }
      if (!entry.isFile() || SNAPSHOT_EXCLUDED.has(entry.name)) continue
      count += 1
      if (count > MAX_SNAPSHOT_FILES) return false
      try {
        const stat = await fsp.stat(path.join(workspacePath, next))
        snapshot[next] = `${stat.size}:${Math.round(stat.mtimeMs)}`
      } catch { return true }
    }
    return true
  }
  const complete = await walk('')
  return complete ? snapshot : undefined
}

/** Paths added, changed or removed between two snapshots, sorted for a stable record. */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const changed = new Set<string>()
  for (const [file, stamp] of Object.entries(before)) if (after[file] !== stamp) changed.add(file)
  for (const file of Object.keys(after)) if (before[file] === undefined) changed.add(file)
  return [...changed].sort()
}
