/** Stable host-side error taxonomy and platform translation. */

export const ERROR_CODES = Object.freeze({
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_WRONG_WORKSPACE: 'SESSION_WRONG_WORKSPACE',
  SESSION_BUSY: 'SESSION_BUSY',
  DELIVERY_REJECTED: 'DELIVERY_REJECTED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  INTERRUPT_UNSUPPORTED: 'INTERRUPT_UNSUPPORTED',
  PLUGIN_DISPOSING: 'PLUGIN_DISPOSING',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  BINDING_STALE: 'BINDING_STALE',
  SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
  STATE_CORRUPT: 'STATE_CORRUPT',
  /** ADR 0006: the reviewed base moved before integration, so the decision must be refreshed. */
  STALE_BASE: 'STALE_BASE',
} as const)

export type ErrorCode = keyof typeof ERROR_CODES
export type ErrorOptions = {
  cause?: unknown
  auditDetail?: string
  details?: Record<string, unknown>
}

/** Audit text used when a member was rebound after command admission. */
export const BINDING_STALE_MESSAGE = 'the member was rebound after this command was admitted'

const SUBAGENT_OWNERSHIP_REASON = 'use subagent delivery for this child session'

const platformErrorMap = new Map<string, ErrorCode>([
  ['session/not-found', 'SESSION_NOT_FOUND'],
  ['session/conflict', 'SESSION_WRONG_WORKSPACE'],
  ['session/workspace-attach-failed', 'SESSION_WRONG_WORKSPACE'],
  ['workspace/not-found', 'SESSION_WRONG_WORKSPACE'],
  ['session/steer-unavailable', 'DELIVERY_REJECTED'],
  ['session/attachment-invalid', 'DELIVERY_REJECTED'],
  ['session/invalid-time-zone', 'DELIVERY_REJECTED'],
  ['session/queue-item-not-found', 'DELIVERY_REJECTED'],
  ['session/model-unavailable', 'MODEL_UNAVAILABLE'],
  ['llm/model-discovery-rejected', 'MODEL_UNAVAILABLE'],
  ['session/title-invalid', 'CAPABILITY_UNAVAILABLE'],
  ['agent-preset/conflict', 'CAPABILITY_UNAVAILABLE'],
  ['session/fork-unavailable', 'CAPABILITY_UNAVAILABLE'],
  ['settings/rejected', 'CAPABILITY_UNAVAILABLE'],
  ['credential/rejected', 'CAPABILITY_UNAVAILABLE'],
  ['subagent/not-found', 'CAPABILITY_UNAVAILABLE'],
  ['subagent/unauthorized', 'CAPABILITY_UNAVAILABLE'],
  ['subagent/catalog-diagnostic', 'CAPABILITY_UNAVAILABLE'],
  ['gateway/cancelled', 'PLUGIN_DISPOSING'],
  ['gateway/bad-request', 'CAPABILITY_UNAVAILABLE'],
  ['gateway/internal', 'CAPABILITY_UNAVAILABLE'],
])

function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code)
}

function rawMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(value ?? 'Unknown platform error')
}

function platformCodeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const object = value as { code?: unknown; details?: { code?: unknown } }
  if (typeof object.code === 'string') return object.code
  if (typeof object.details?.code === 'string') return object.details.code
  return undefined
}

function platformReasonOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const details = (value as { details?: { reason?: unknown } }).details
  return typeof details?.reason === 'string' ? details.reason : undefined
}

export class LiveTeamsError extends Error {
  readonly code: ErrorCode
  readonly auditDetail: string | undefined
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode | string, message: string, options: ErrorOptions = {}) {
    const normalizedCode: ErrorCode = isErrorCode(code) ? code : 'CAPABILITY_UNAVAILABLE'
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LiveTeamsError'
    this.code = normalizedCode
    this.auditDetail = options.auditDetail ?? message
    this.details = options.details ?? {}
  }
}

/** Translate platform failures into stable domain errors. */
export function translatePlatformError(error: unknown): LiveTeamsError {
  if (error instanceof LiveTeamsError) return error
  const sourceCode = platformCodeOf(error)
  const reason = platformReasonOf(error)
  let code: ErrorCode
  if (sourceCode === 'session/agent-busy') {
    code = reason?.includes(SUBAGENT_OWNERSHIP_REASON)
      ? 'CAPABILITY_UNAVAILABLE'
      : 'SESSION_BUSY'
  } else {
    code = (sourceCode === undefined ? undefined : platformErrorMap.get(sourceCode))
      ?? 'CAPABILITY_UNAVAILABLE'
  }
  const mapped = sourceCode === undefined || platformErrorMap.has(sourceCode) || sourceCode === 'session/agent-busy'
  const detail = mapped ? rawMessage(error) : `platform code ${sourceCode}: ${rawMessage(error)}`
  return new LiveTeamsError(code, code, {
    auditDetail: detail,
    cause: error,
    details: {
      ...(sourceCode === undefined ? {} : { platformCode: sourceCode }),
      ...(reason === undefined ? {} : { reason }),
    },
  })
}

export function platformErrorMappings(): ReadonlyMap<string, ErrorCode> {
  return platformErrorMap
}
