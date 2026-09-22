import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { BINDING_STALE_MESSAGE, ERROR_CODES, LiveTeamsError, type ErrorCode } from './errors.js'
import { atomicWriteJson, clone, fileExists, readJson, withProcessLock } from './storage.js'

export type CommandState = 'pending' | 'leased' | 'admitted' | 'applied' | 'failed'
export interface CommandRecord {
  commandId: string
  idempotencyKey: string
  causationId: string | undefined
  sessionId: string
  bindingGeneration: number
  mode: 'queue' | 'steer'
  reason: string
  content: readonly unknown[]
  requestId: string
  state: CommandState
  receipt: string | undefined
  failureCode: ErrorCode | undefined
  failureDetail: string | undefined
  revision: number
}

const DELIVERED_STATES = new Set<CommandState>(['admitted', 'applied'])
const AWAITING_DELIVERY_STATES = new Set<CommandState>(['pending', 'leased'])
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function findByIdempotencyKey(records: readonly CommandRecord[], key: string): CommandRecord | undefined { return records.find((record) => record.idempotencyKey === key) }

type QueueOptions = {
  workspacePath: string
  teamId: string
  deliver: (record: CommandRecord) => Promise<{ accepted?: true } | void>
  bindingGenerationOf?: ((sessionId: string) => Promise<number | undefined> | number | undefined) | undefined
  now?: (() => number) | undefined
}
type AdmissionRequest = { idempotencyKey: string; sessionId: string; bindingGeneration: number; mode: 'queue' | 'steer'; content: readonly unknown[]; reason?: string; causationId?: string }

export class SessionCommandQueue {
  private readonly workspacePath: string
  private readonly teamId: string
  private readonly deliver: QueueOptions['deliver']
  private readonly bindingGenerationOf: QueueOptions['bindingGenerationOf']
  private readonly now: () => number
  private readonly file: string

  constructor(options: QueueOptions) {
    if (text(options?.workspacePath) === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'command queue requires a workspacePath')
    if (text(options?.teamId) === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'command queue requires a teamId')
    if (typeof options?.deliver !== 'function') throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'command queue requires a delivery port')
    this.workspacePath = path.resolve(options.workspacePath)
    this.teamId = options.teamId
    this.deliver = options.deliver
    this.bindingGenerationOf = options.bindingGenerationOf
    this.now = options.now ?? Date.now
    void this.now
    this.file = path.join(this.workspacePath, '.dsh-live-teams', 'teams', this.teamId, 'commands.json')
  }

  async list(): Promise<CommandRecord[]> { return this.read() }
  async listPending(teamId?: string): Promise<CommandRecord[]> {
    if (teamId !== undefined && teamId !== this.teamId) return []
    return (await this.read()).filter((record) => AWAITING_DELIVERY_STATES.has(record.state))
  }

  async admit(request: AdmissionRequest): Promise<{ record: CommandRecord; duplicate: boolean }> {
    const idempotencyKey = text(request?.idempotencyKey)
    const sessionId = text(request?.sessionId)
    if (idempotencyKey === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'admit requires an idempotencyKey')
    if (sessionId === undefined) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'admit requires a sessionId')
    if (request.mode !== 'queue' && request.mode !== 'steer') throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, `Unsupported delivery mode "${String(request.mode)}"`)
    if (!Number.isInteger(request.bindingGeneration)) throw new LiveTeamsError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'admit requires a bindingGeneration')
    return this.mutate((records) => {
      const existing = findByIdempotencyKey(records, idempotencyKey)
      if (existing !== undefined) return { record: clone(existing), duplicate: true }
      const record: CommandRecord = {
        commandId: randomUUID(), idempotencyKey, causationId: text(request.causationId), sessionId,
        bindingGeneration: request.bindingGeneration, mode: request.mode, reason: text(request.reason) ?? 'unspecified',
        content: clone(request.content ?? []), requestId: `${this.teamId}:${idempotencyKey}`, state: 'pending', receipt: undefined,
        failureCode: undefined, failureDetail: undefined, revision: 1,
      }
      records.push(record)
      return { record: clone(record), duplicate: false }
    })
  }

  async dispatch(commandId: string): Promise<CommandRecord> {
    const reserved = await this.transition(commandId, (record) => {
      if (DELIVERED_STATES.has(record.state)) return { next: record, stop: true }
      record.state = 'leased'; record.revision += 1
      return { next: record, stop: false, call: true }
    })
    if (reserved.call !== true) return reserved.record
    let outcome: { state: CommandState; receipt?: string; failureCode?: ErrorCode; failureDetail?: string }
    try {
      const current = typeof this.bindingGenerationOf === 'function' ? await this.bindingGenerationOf(reserved.record.sessionId) : reserved.record.bindingGeneration
      if (current !== undefined && current !== reserved.record.bindingGeneration) throw new LiveTeamsError(ERROR_CODES.BINDING_STALE, BINDING_STALE_MESSAGE, { auditDetail: `admitted for generation ${reserved.record.bindingGeneration}, current ${current}` })
      await this.deliver(clone(reserved.record))
      outcome = { state: 'admitted', receipt: 'accepted' }
    } catch (error) {
      const domain = error instanceof LiveTeamsError ? error : new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, error instanceof Error ? error.message : String(error), { cause: error })
      outcome = { state: 'failed', failureCode: domain.code, failureDetail: domain.auditDetail ?? domain.message }
    }
    return (await this.transition(commandId, (record) => {
      record.state = outcome.state; record.receipt = outcome.receipt; record.failureCode = outcome.failureCode; record.failureDetail = outcome.failureDetail; record.revision += 1
      return { next: record, stop: true }
    })).record
  }

  async retry(commandId: string): Promise<CommandRecord> {
    const prepared = await this.transition(commandId, (record) => {
      record.state = 'pending'; record.receipt = undefined; record.failureCode = undefined; record.failureDetail = undefined; record.revision += 1
      return { next: record, stop: true }
    })
    const before = (await this.read()).length
    const dispatched = await this.dispatch(prepared.record.commandId)
    const after = (await this.read()).length
    if (before !== after) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'retry changed the number of durable commands')
    return dispatched
  }

  async get(commandId: string): Promise<CommandRecord | undefined> {
    const record = (await this.read()).find((entry) => entry.commandId === commandId)
    return record === undefined ? undefined : clone(record)
  }

  private async transition(commandId: string, change: (record: CommandRecord) => { next: CommandRecord; stop: boolean; call?: boolean }): Promise<{ record: CommandRecord; call?: boolean }> {
    return this.mutate((records) => {
      const index = records.findIndex((entry) => entry.commandId === commandId)
      if (index < 0) throw new LiveTeamsError(ERROR_CODES.DELIVERY_REJECTED, `unknown command "${commandId}"`)
      const outcome = change(records[index]!)
      records[index] = outcome.next
      return { record: clone(outcome.next), call: outcome.call === true }
    })
  }

  private async mutate<T>(change: (records: CommandRecord[]) => T): Promise<T> {
    return withProcessLock(this.file, async () => {
      const records = await this.read()
      const result = change(records)
      await atomicWriteJson(this.file, { schemaVersion: 1, teamId: this.teamId, commands: records })
      return result
    })
  }

  private async read(): Promise<CommandRecord[]> {
    if (!(await fileExists(this.file))) return []
    let parsed: unknown
    try { parsed = await readJson(this.file) } catch (error) { throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'command state is not readable JSON', { cause: error, auditDetail: `failed to read ${this.file}` }) }
    const commands = parsed !== null && typeof parsed === 'object' ? (parsed as { commands?: unknown }).commands : undefined
    if (!Array.isArray(commands)) throw new LiveTeamsError(ERROR_CODES.STATE_CORRUPT, 'command state has no command list', { auditDetail: `invalid shape in ${this.file}` })
    return commands as CommandRecord[]
  }
}
export function createCommandQueue(options: QueueOptions): SessionCommandQueue { return new SessionCommandQueue(options) }
