import { LiveTeamsError, translatePlatformError } from './errors.js'

export interface SessionDescriptor {
  sessionId: string
  workspaceId: string | undefined
  cwd: string | undefined
  title: string | undefined
  status: 'idle' | 'running' | 'unknown'
  live: boolean
  subagentOwned: boolean
  seq: number
  agentPreset: string | undefined
  /**
   * DSH's Session-list projection keeps a Session blank until its first
   * `turn/start`, and the session list hides blank Sessions: the Workspace
   * browser adopts one as its provisional "New session" row and never lists it
   * (`sessionVisible` / `connectWorkspace` in @deepseek-ai/dsh-client-ui-workspace).
   *
   * Only `list` reports this flag, so `undefined` means "not reported", never
   * "known to be visible".
   */
  blank?: boolean
}

export interface SessionController {
  create(payload: Record<string, unknown>): Promise<unknown>
  inspect(sessionId: string): Promise<unknown>
  list?(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  rename(payload: { sessionId: string; title: string }): Promise<unknown>
  prompt(payload: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: readonly unknown[] }, signal: AbortSignal): Promise<unknown>
  cancel(payload: { sessionId: string }): void
}

export interface SessionBridge {
  create(request: { sessionId?: string; workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<SessionDescriptor>
  inspect(sessionId: string): Promise<SessionDescriptor | undefined>
  validateAttachment(sessionId: string, workspaceId: string): Promise<SessionDescriptor>
  rename(sessionId: string, title: string): Promise<{ title: string; seq: number | undefined }>
  selectModel(sessionId: string, selection: unknown): never
  deliver(sessionId: string, envelope: { requestId: string; mode: 'queue' | 'steer'; content: readonly unknown[] }): Promise<{ accepted: true }>
  interrupt(sessionId: string, reason: string): Promise<{ accepted: true }>
  reconcile(sessionIds: readonly string[]): Promise<SessionDescriptor[]>
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function isSubagentHeader(header: unknown): boolean {
  const value = record(header)
  return value.origin === 'subagent' || text(value.parentSession) !== undefined
}
function isMissingSession(error: unknown): boolean {
  const value = record(error)
  if (value.code === 'session/not-found') return true
  if (typeof value.code === 'string' && value.code.length > 0) return false
  return /not found/i.test(String(value.message ?? ''))
}
function isSubagentOwnership(error: unknown): boolean {
  const value = record(error)
  if (value.code !== 'session/agent-busy') return false
  const details = record(value.details)
  return /subagent/i.test(String(details.reason ?? value.message ?? ''))
}

export function toBridgeError(error: unknown): LiveTeamsError {
  if (error instanceof LiveTeamsError) return error
  const translated = translatePlatformError(error)
  if (!isSubagentOwnership(error)) return translated
  return new LiveTeamsError('CAPABILITY_UNAVAILABLE', 'Session is owned by subagent routing and cannot be a team member', translated.auditDetail === undefined ? { cause: error } : { cause: error, auditDetail: translated.auditDetail })
}

function descriptorOf(inspection: RecordValue, liveAgent: unknown): SessionDescriptor {
  const liveSession = record(record(liveAgent).session)
  const meta = record(inspection.meta ?? inspection.header ?? liveSession.header)
  const session = record(liveAgent).session
  const ownerHeader = record(session).header ?? meta
  const events = Array.isArray(inspection.events) ? inspection.events : []
  let title = text(meta.title)
  let seq = typeof meta.seq === 'number' ? meta.seq : 0
  for (const event of events) {
    const value = record(event)
    if (typeof value.seq === 'number' && value.seq > seq) seq = value.seq
    if (value.type === 'session/title') title = text(record(value.data).title) ?? title
  }
  const statusValue = record(liveAgent).status
  return {
    sessionId: text(meta.id) ?? '',
    workspaceId: text(meta.workspaceId),
    cwd: text(meta.cwd),
    title,
    status: statusValue === 'idle' || statusValue === 'running' ? statusValue : 'unknown',
    live: liveAgent !== undefined && liveAgent !== null,
    subagentOwned: isSubagentHeader(ownerHeader),
    seq,
    agentPreset: text(meta.agentPreset),
  }
}

export interface SessionBridgeDeps { controller: SessionController | null | undefined; agents?: { get?: (sessionId: string) => unknown } }
export function createSessionBridge({ controller, agents }: SessionBridgeDeps): SessionBridge {
  if (controller === null || typeof controller !== 'object') throw new LiveTeamsError('CAPABILITY_UNAVAILABLE', 'sessionController is not available in this composition')
  const liveAgentOf = (sessionId: string): unknown => agents?.get?.(sessionId)
  const bridge: SessionBridge = {
    async create(request) {
      const sessionId = text(request?.sessionId)
      if (sessionId === undefined) throw new LiveTeamsError('CAPABILITY_UNAVAILABLE', 'create requires an explicit plugin-owned sessionId')
      const payload: Record<string, unknown> = { sessionId }
      if (text(request.workspaceId) !== undefined) payload.workspaceId = request.workspaceId
      if (text(request.cwd) !== undefined) payload.cwd = request.cwd
      if (text(request.agentPreset) !== undefined) payload.agentPreset = request.agentPreset
      try { await controller.create(payload) } catch (error) { throw toBridgeError(error) }
      const descriptor = await bridge.inspect(sessionId)
      if (descriptor === undefined) throw new LiveTeamsError('SESSION_NOT_FOUND', `Session "${sessionId}" was not readable after create`, { auditDetail: 'create succeeded but inspect could not observe the Session' })
      return descriptor
    },
    async inspect(sessionId) {
      try { return descriptorOf(record(await controller.inspect(sessionId)), liveAgentOf(sessionId)) } catch (error) {
        if (isMissingSession(error)) return undefined
        throw toBridgeError(error)
      }
    },
    async validateAttachment(sessionId, workspaceId) {
      const descriptor = await bridge.inspect(sessionId)
      if (descriptor === undefined) throw new LiveTeamsError('SESSION_NOT_FOUND', `Session "${sessionId}" does not exist`, { auditDetail: 'validateAttachment: inspect returned no Session' })
      if (descriptor.subagentOwned) throw new LiveTeamsError('CAPABILITY_UNAVAILABLE', `Session "${sessionId}" is owned by subagent routing`, { auditDetail: 'validateAttachment: subagent-owned Session cannot be a member' })
      const expected = text(workspaceId)
      if (expected !== undefined && descriptor.workspaceId !== expected) throw new LiveTeamsError('SESSION_WRONG_WORKSPACE', `Session "${sessionId}" is not attached to workspace "${expected}"`, { auditDetail: `observed workspaceId=${String(descriptor.workspaceId)}` })
      return descriptor
    },
    async rename(sessionId, title) {
      try { const result = record(await controller.rename({ sessionId, title })); return { title: text(result.title) ?? title, seq: typeof result.seq === 'number' ? result.seq : undefined } } catch (error) { throw toBridgeError(error) }
    },
    selectModel() {
      throw new LiveTeamsError('CAPABILITY_UNAVAILABLE', 'Model selection is intentionally unavailable in this build', { auditDetail: 'Phase 2 policy omits member model selection because selectModel also rewrites the deployment-wide default model. This must not be worked around silently.' })
    },
    async deliver(sessionId, envelope) {
      if (envelope.mode !== 'queue' && envelope.mode !== 'steer') throw new LiveTeamsError('DELIVERY_REJECTED', `Unsupported delivery mode "${String(envelope.mode)}"`)
      try { await controller.prompt({ requestId: envelope.requestId, sessionId, mode: envelope.mode, content: envelope.content }, new AbortController().signal); return { accepted: true } } catch (error) { throw toBridgeError(error) }
    },
    async interrupt(sessionId, _reason) {
      try { controller.cancel({ sessionId }); return { accepted: true } } catch (error) { throw toBridgeError(error) }
    },
    async reconcile(sessionIds) {
      const descriptors: SessionDescriptor[] = []
      for (const sessionId of sessionIds) { const descriptor = await bridge.inspect(sessionId); if (descriptor !== undefined) descriptors.push(descriptor) }
      return descriptors
    },
  }
  return Object.freeze(bridge)
}
