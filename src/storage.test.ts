import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { atomicWrite } from './storage.js'

const eperm = Object.assign(new Error('operation not permitted, fsync'), { code: 'EPERM' })

async function exercise(platform: NodeJS.Platform, failure: 'file' | 'directory', expected: 'success' | 'failure', error = eperm): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'live-teams-storage-'))
  const destination = join(dir, 'record.json')
  const originalOpen = fs.open
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const close = vi.fn(async () => {})
  const sync = vi.fn(async () => {
    if (failure === 'directory') throw error
  })
  await fs.writeFile(destination, 'old')
  const open = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    if (file === dir && flags === 'r') return { sync, close } as unknown as Awaited<ReturnType<typeof fs.open>>
    const handle = await originalOpen(file, flags, mode)
    if (flags === 'wx' && failure === 'file') vi.spyOn(handle, 'sync').mockRejectedValue(error)
    return handle
  })
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform })
  try {
    const write = atomicWrite(destination, 'new')
    if (expected === 'success') await expect(write).resolves.toBeUndefined()
    else await expect(write).rejects.toBe(error)
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor)
    open.mockRestore()
    try {
      expect(await fs.readFile(destination, 'utf8')).toBe(failure === 'file' ? 'old' : 'new')
      expect(await fs.readdir(dir)).toEqual(['record.json'])
      expect(sync).toHaveBeenCalledTimes(failure === 'file' ? 0 : 1)
      expect(close).toHaveBeenCalledTimes(failure === 'file' ? 0 : 1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

describe('atomicWrite directory durability', () => {
  it('accepts Windows EPERM only after atomically replacing the flushed file', () =>
    exercise('win32', 'directory', 'success'))

  it('propagates EPERM when flushing the temporary file on Windows', () =>
    exercise('win32', 'file', 'failure'))

  it('propagates EPERM when flushing a directory on Linux', () =>
    exercise('linux', 'directory', 'failure'))

  it('propagates other directory flush errors on Windows', () =>
    exercise('win32', 'directory', 'failure', Object.assign(new Error('I/O error'), { code: 'EIO' })))
})
