import { describe, expect, it } from 'vitest'
import { ERROR_CODES, LiveTeamsError, platformErrorMappings, translatePlatformError } from './errors.js'

describe('error taxonomy', () => {
  it('keeps stable codes and human message separate', () => { const error = new LiveTeamsError('SESSION_BUSY', 'busy now', { auditDetail: 'platform detail', details: { retryable: true } }); expect(error.code).toBe('SESSION_BUSY'); expect(error.message).toBe('busy now'); expect(error.auditDetail).toBe('platform detail'); expect(error.details).toEqual({ retryable: true }) })
  it('normalizes unknown codes to capability unavailable', () => { expect(new LiveTeamsError('unknown', 'message').code).toBe(ERROR_CODES.CAPABILITY_UNAVAILABLE) })
  it('maps platform errors and preserves subagent reason', () => { expect(translatePlatformError({ code: 'session/agent-busy', message: 'busy', details: { reason: 'cannot admit' } })).toMatchObject({ code: 'SESSION_BUSY', details: { reason: 'cannot admit' } }); expect(translatePlatformError({ code: 'session/agent-busy', message: 'child', details: { reason: 'use subagent delivery for this child session' } }).code).toBe('CAPABILITY_UNAVAILABLE') })
  it('maps uncoded and unknown failures without exposing raw platform code as message', () => { const uncoded = translatePlatformError(new Error('raw')); expect(uncoded.code).toBe('CAPABILITY_UNAVAILABLE'); expect(uncoded.message).toBe('CAPABILITY_UNAVAILABLE'); const unknown = translatePlatformError({ code: 'future/new', message: 'future failure' }); expect(unknown.code).toBe('CAPABILITY_UNAVAILABLE'); expect(unknown.message).toBe('CAPABILITY_UNAVAILABLE'); expect(unknown.auditDetail).toMatch(/future\/new/) })
  it('exposes read-only mappings', () => { expect(platformErrorMappings().get('session/not-found')).toBe('SESSION_NOT_FOUND') })
})
