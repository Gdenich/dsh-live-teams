import { promises as fs } from 'node:fs'
import path from 'node:path'

let temporaryFileCounter = 0
const locks = new Map<string, Promise<void>>()

export async function withProcessLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

export async function atomicWrite(filePath: string, contents: string | Uint8Array): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const basename = path.basename(filePath)
  const temporaryPath = path.join(directory, `.${basename}.${process.pid}.${Date.now()}.${temporaryFileCounter++}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, filePath)
    const directoryHandle = await fs.open(directory, 'r')
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await fs.unlink(temporaryPath).catch(() => undefined)
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

export const CURRENT_SCHEMA_VERSION = 1

/**
 * The tasks file has its own version, because it has its own shape.
 *
 * 2 — tasks carry `awaitsDecision` (a submission is in and nobody has decided on it). The flag was
 * added after a live stand showed a task that could be neither accepted nor closed: the store and
 * the panel both derived the answer from the status, and a returned task is `in_progress` while its
 * submission is still on the table.
 *
 * One constant for every file made the team store expect a version it never wrote, and the host
 * integration tests caught it. A version belongs to a file.
 */
export const TASKS_SCHEMA_VERSION = 2
