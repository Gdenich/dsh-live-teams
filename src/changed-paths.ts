import { execFile } from 'node:child_process'

/**
 * What changed in a workspace, for the declared-scope check (B30).
 *
 * The store never shells out itself: it takes a port, and the plugin supplies this
 * adapter. `undefined` means "not observable" — no git, not a repository, an
 * unparsable answer, or more changes than the cap — and is recorded as `unchecked`
 * rather than as a clean result.
 *
 * `--porcelain -z` is used because the output is byte-exact: entries are NUL separated,
 * a rename prints the *new* path first and the original as the next record, and no
 * quoting or escaping is applied to unusual file names.
 */
export const CHANGED_PATHS_LIMIT = 2000

export function parsePorcelainZ(stdout: string): string[] | undefined {
  const records = stdout.split('\0')
  const changed: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string
    if (record.length === 0) continue
    // `XY <path>`: two status characters, a space, then the path.
    if (record.length < 4 || record[2] !== ' ') return undefined
    const status = record.slice(0, 2)
    const target = record.slice(3)
    if (target.length === 0) return undefined
    changed.push(target)
    // A rename or copy prints its source as the next record; the destination is what
    // this check cares about, so the source is consumed and not reported.
    if (status[0] === 'R' || status[0] === 'C') index += 1
    if (changed.length > CHANGED_PATHS_LIMIT) return undefined
  }
  return changed
}

/**
 * What the member *committed* during its attempt.
 *
 * `git status` shows uncommitted work only, so a member that commits — which is what a careful
 * engineer does, and what the repository's own conventions ask for — looked like it had changed
 * nothing, and a report submission was refused with "nothing changed under the declaration" (found
 * by a Builder on a real stand). The work is the union: what is still in the tree, and what was
 * committed since the attempt took its base.
 */
export async function gitCommittedPaths(workspacePath: string, base: string): Promise<string[] | undefined> {
  return await new Promise<string[] | undefined>((resolve) => {
    execFile('git', ['-C', workspacePath, 'diff', '--name-only', '--no-renames', `${base}..HEAD`], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      const paths = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      resolve(paths.length > CHANGED_PATHS_LIMIT ? undefined : paths)
    })
  })
}

export async function gitChangedPaths(workspacePath: string): Promise<string[] | undefined> {
  return await new Promise<string[] | undefined>((resolve) => {
    execFile('git', ['-C', workspacePath, 'status', '--porcelain', '-z'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      resolve(parsePorcelainZ(stdout))
    })
  })
}


/**
 * B32: which observation a workspace supports.
 *
 * `git` when the workspace is a work tree, `files` otherwise. A directory that is not a
 * repository is a first-class case (a plugin folder, a document, a research tree), not a
 * degraded one: the declaration is checked the same way, only the evidence differs.
 */
export type WorkspaceMode = 'git' | 'files'

export async function workspaceMode(workspacePath: string): Promise<WorkspaceMode | undefined> {
  return await new Promise<WorkspaceMode | undefined>((resolve) => {
    execFile('git', ['-C', workspacePath, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 }, (error, stdout) => {
      if (error) { resolve('files'); return }
      resolve(stdout.trim() === 'true' ? 'git' : 'files')
    })
  })
}
