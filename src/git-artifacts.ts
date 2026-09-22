import { execFile } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Git plumbing for Git-bound submissions (Phase 6, ADR 0006).
 *
 * The plugin — not the member — turns the submitted paths into one commit, and it does so without
 * touching the branch, the index or any other file in the tree. That matters because members share
 * one checkout: switching branches or staging paths would disturb a colleague's work in progress.
 * Everything here is plumbing, so the only visible effect is a new object and a plugin-owned ref.
 *
 * `undefined` means "not observable" everywhere: no repository, no commit, an unreadable answer.
 * The caller records that honestly rather than inventing a result.
 */

const GIT_TIMEOUT_MS = 20000

async function git(workspacePath: string, args: readonly string[], options: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<{ stdout: string; ok: boolean }> {
  return await new Promise((resolve) => {
    const child = execFile('git', ['-C', workspacePath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    }, (error, stdout) => resolve({ stdout: String(stdout), ok: error === null }))
    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })
}

export type BaseInfo = { readonly ref: string; readonly sha: string }

/** The branch and tip a piece of work is based on. `undefined` in a repository with no commits. */
export async function baseInfo(workspacePath: string): Promise<BaseInfo | undefined> {
  const head = await git(workspacePath, ['rev-parse', 'HEAD'])
  if (!head.ok) return undefined
  const sha = head.stdout.trim()
  const symbolic = await git(workspacePath, ['symbolic-ref', '-q', 'HEAD'])
  // A detached HEAD has no branch to integrate into, and is reported as such rather than guessed.
  if (!symbolic.ok) return undefined
  const ref = symbolic.stdout.trim()
  return ref.length === 0 || !/^[0-9a-f]{40}$/u.test(sha) ? undefined : { ref, sha }
}

export type BuiltCommit = {
  readonly headSha: string
  readonly treeSha: string
  readonly commitPaths: readonly string[]
  readonly mergeBaseSha?: string
}

export type CommitRequest = {
  readonly paths: readonly string[]
  readonly message: string
  readonly author: { readonly name: string; readonly email: string }
}

/** The entries of a commit's tree, flattened to `path → mode:sha`, for building on top of it. */
async function baseTree(workspacePath: string, base: BaseInfo | undefined): Promise<Map<string, { mode: string; sha: string }> | undefined> {
  const entries = new Map<string, { mode: string; sha: string }>()
  if (base === undefined) return entries
  const listed = await git(workspacePath, ['ls-tree', '-r', '-z', base.sha])
  if (!listed.ok) return undefined
  for (const record of listed.stdout.split('\0')) {
    if (record.length === 0) continue
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/su.exec(record)
    if (match === null || match[2] !== 'blob') continue
    entries.set(match[4] as string, { mode: match[1] as string, sha: match[3] as string })
  }
  return entries
}

/**
 * Build one commit from exactly these paths, parented on `base`.
 *
 * The tree is the *base tree* with the submitted paths replaced: a commit built from scratch would
 * delete everything the submission did not mention, which the first probe of this module caught by
 * showing four changed paths where two were submitted. Blobs are written with `hash-object -w`,
 * directories assembled bottom-up with `mktree`, and `commit-tree` writes the commit — no index, no
 * checkout, no branch moved.
 *
 * A submitted path that is missing from disk is a deletion when the base had it, and a refusal when
 * it did not: a submission cannot claim a file that never existed.
 */
export async function commitPaths(workspacePath: string, base: BaseInfo | undefined, request: CommitRequest): Promise<BuiltCommit | undefined> {
  if (request.paths.length === 0) return undefined
  const sorted = [...new Set(request.paths)].sort((left, right) => left.localeCompare(right))
  const entries = await baseTree(workspacePath, base)
  if (entries === undefined) return undefined
  for (const relative of sorted) {
    const absolute = path.resolve(workspacePath, relative)
    if (absolute !== workspacePath && !absolute.startsWith(`${workspacePath}${path.sep}`)) return undefined
    // Exact bytes, and the mode the filesystem reports. Reading the content as a latin1 string and
    // handing that string to stdin re-encodes it as UTF-8, which silently corrupts every byte above
    // 0x7f (proved by a probe: 0x89 came back as 0xc2 0x89). A symlink is a blob holding its target
    // with mode 120000, and the executable bit comes from the file itself — a plugin that commits
    // on a member's behalf must not change what the member produced.
    let content: Buffer | undefined
    let mode = '100644'
    try {
      const stat = await fsp.lstat(absolute)
      if (stat.isSymbolicLink()) {
        content = Buffer.from(await fsp.readlink(absolute))
        mode = '120000'
      } else {
        content = await fsp.readFile(absolute)
        if ((stat.mode & 0o111) !== 0) mode = '100755'
      }
    } catch { content = undefined }
    if (content === undefined) {
      if (!entries.has(relative)) return undefined
      entries.delete(relative)
      continue
    }
    const written = await git(workspacePath, ['hash-object', '-w', '--stdin'], { input: content })
    if (!written.ok) return undefined
    entries.set(relative, { mode, sha: written.stdout.trim() })
  }

  // Assemble the tree bottom-up from the complete entry map: one `mktree` per directory.
  const treeOf = async (prefix: string): Promise<string | undefined> => {
    const fileLines: string[] = []
    // A directory belongs in this tree when its parent *is* this prefix: counting slashes got the
    // root level wrong and dropped a whole directory, which made the commit look like a deletion.
    const parentOf = (directory: string): string => {
      const trimmed = directory.endsWith('/') ? directory.slice(0, -1) : directory
      const cut = trimmed.lastIndexOf('/')
      return cut < 0 ? '' : trimmed.slice(0, cut + 1)
    }
    const directories = new Set<string>()
    for (const [relative, entry] of entries) {
      if (!relative.startsWith(prefix)) continue
      const rest = relative.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash >= 0) { directories.add(`${prefix}${rest.slice(0, slash)}/`); continue }
      fileLines.push(`${entry.mode} blob ${entry.sha}\t${rest}`)
    }
    const treeLines: string[] = []
    for (const directory of [...directories].sort()) {
      if (parentOf(directory) !== prefix) continue
      const child = await treeOf(directory)
      if (child === undefined) return undefined
      treeLines.push(`040000 tree ${child}\t${directory.slice(prefix.length, -1)}`)
    }
    const built = await git(workspacePath, ['mktree'], { input: `${[...treeLines, ...fileLines].join('\n')}\n` })
    if (!built.ok) return undefined
    return built.stdout.trim()
  }
  const treeSha = await treeOf('')
  if (treeSha === undefined) return undefined

  const args = ['commit-tree', treeSha]
  if (base !== undefined) args.push('-p', base.sha)
  args.push('-m', request.message)
  const committed = await git(workspacePath, args, {
    env: {
      GIT_AUTHOR_NAME: request.author.name,
      GIT_AUTHOR_EMAIL: request.author.email,
      GIT_COMMITTER_NAME: 'live-teams',
      GIT_COMMITTER_EMAIL: 'live-teams@localhost',
    },
  })
  if (!committed.ok) return undefined
  const headSha = committed.stdout.trim()
  if (!/^[0-9a-f]{40}$/u.test(headSha)) return undefined

  let mergeBaseSha: string | undefined
  if (base !== undefined) {
    const baseMerge = await git(workspacePath, ['merge-base', base.sha, headSha])
    if (baseMerge.ok) mergeBaseSha = baseMerge.stdout.trim() || undefined
  }
  return { headSha, treeSha, commitPaths: sorted, ...(mergeBaseSha === undefined ? {} : { mergeBaseSha }) }
}

/** Keep a built commit reachable, so `git gc` cannot take the reviewed artifact away. */
export async function pinCommit(workspacePath: string, ref: string, sha: string): Promise<boolean> {
  const pinned = await git(workspacePath, ['update-ref', ref, sha])
  return pinned.ok
}

/** The current tip of a branch, for the acceptance precondition. */
export async function refTip(workspacePath: string, ref: string): Promise<string | undefined> {
  const tip = await git(workspacePath, ['rev-parse', '--verify', '--quiet', ref])
  return tip.ok && /^[0-9a-f]{40}$/u.test(tip.stdout.trim()) ? tip.stdout.trim() : undefined
}

/**
 * Integrate by compare-and-swap: advance the branch only if it is still where the review left it.
 *
 * The working tree already holds the work, so nothing is checked out and nothing is merged. The
 * old-value argument is what makes this safe: a base that moved underneath the decision fails here
 * instead of silently rewriting history or absorbing a review that no longer applies.
 */
export type IntegrationOutcome = 'integrated' | 'stale' | 'index-failed'

async function repairIndex(workspacePath: string, commitPaths: readonly string[]): Promise<boolean> {
  if (commitPaths.length === 0) return true
  const repaired = await git(workspacePath, ['reset', '-q', '--', ...commitPaths])
  return repaired.ok
}

export async function integrateCommit(workspacePath: string, ref: string, headSha: string, expectedTip: string | undefined, commitPaths: readonly string[] = []): Promise<IntegrationOutcome> {
  // Idempotent on purpose. A process that died between moving the ref and writing the task state
  // leaves the branch at `headSha` with the task still open; retrying the acceptance must finish the
  // job rather than report STALE_BASE, which is what happened before this check existed. A tip that
  // is neither the expected base nor our commit is somebody else's work: that is a real stale base.
  const current = await git(workspacePath, ['rev-parse', '--verify', '--quiet', ref])
  const tip = current.ok && /^[0-9a-f]{40}$/u.test(current.stdout.trim()) ? current.stdout.trim() : undefined
  if (tip === headSha) return await repairIndex(workspacePath, commitPaths) ? 'integrated' : 'index-failed'
  if (expectedTip !== undefined && tip !== expectedTip) return 'stale'
  const args = ['update-ref', ref, headSha]
  if (expectedTip !== undefined) args.push(expectedTip)
  const updated = await git(workspacePath, args)
  if (!updated.ok) return 'stale'
  // The index is still positioned on the old base for these paths, so a plain `git commit` later
  // would silently revert the accepted work. `git reset -- <paths>` moves the index entries to the
  // new HEAD and leaves the working tree exactly as it is (the test that caught this asserted a
  // clean status after integration).
  // The branch has moved, so a failed repair cannot be undone here: it is reported as its own
  // outcome so the caller records it and retries, instead of leaving an index that a later plain
  // commit would use to revert accepted work.
  return await repairIndex(workspacePath, commitPaths) ? 'integrated' : 'index-failed'
}

/** Paths a commit changes relative to a base, for a reviewer that wants the list. */
export async function commitPathsOf(workspacePath: string, from: string, to: string): Promise<string[] | undefined> {
  const diff = await git(workspacePath, ['diff', '--name-only', `${from}..${to}`])
  if (!diff.ok) return undefined
  return diff.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}
