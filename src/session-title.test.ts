import { describe, expect, it, vi } from 'vitest'
import { applySessionTitle, sessionTitleFor } from './session-title.js'

function dependencies(rename?: (sessionId: string, title: string) => Promise<unknown>) {
  const calls: Array<[string, string]> = []
  return {
    calls,
    warn: vi.fn(),
    rename: async (sessionId: string, title: string) => {
      calls.push([sessionId, title])
      return rename === undefined ? { title, seq: 1 } : rename(sessionId, title)
    },
  }
}

describe('session titles', () => {
  it('formats the member name and the team name with a spaced hyphen', () => {
    expect(sessionTitleFor('Builder', 'B1 Check')).toBe('Builder - B1 Check')
  })

  it('titles a Session that had none and reports the missing previous title', async () => {
    const deps = dependencies()
    const result = await applySessionTitle(deps, { sessionId: 's-1', displayName: 'Builder', teamName: 'B1 Check', reason: 'member-added' })
    expect(deps.calls).toEqual([['s-1', 'Builder - B1 Check']])
    expect(result).toEqual({ from: null, to: 'Builder - B1 Check', reason: 'member-added', renamed: true })
  })

  it('renames an adopted Session and keeps its previous title', async () => {
    const deps = dependencies()
    const result = await applySessionTitle(deps, { sessionId: 's-2', displayName: 'Lead', teamName: 'B1 Check', reason: 'member-added', previousTitle: 'Приветствие в чате' })
    expect(deps.calls).toEqual([['s-2', 'Lead - B1 Check']])
    expect(result?.from).toBe('Приветствие в чате')
    expect(result?.renamed).toBe(true)
  })

  it('leaves a matching title alone, so repeated operations stay quiet', async () => {
    const deps = dependencies()
    const result = await applySessionTitle(deps, { sessionId: 's-3', displayName: 'Builder', teamName: 'B1 Check', reason: 'member-renamed', previousTitle: 'Builder - B1 Check' })
    expect(deps.calls).toEqual([])
    expect(result).toEqual({ from: 'Builder - B1 Check', to: 'Builder - B1 Check', reason: 'member-renamed', renamed: false })
  })

  it('reports a failed rename instead of throwing, so membership is unaffected', async () => {
    const deps = dependencies(async () => { throw new Error('no title service') })
    const result = await applySessionTitle(deps, { sessionId: 's-4', displayName: 'Builder', teamName: 'B1 Check', reason: 'member-added' })
    expect(result).toBeUndefined()
    expect(deps.warn).toHaveBeenCalledOnce()
    expect(String(deps.warn.mock.calls[0]?.[0])).toContain('no title service')
  })

  it('renames with the new member name when a member is renamed', async () => {
    const deps = dependencies()
    const result = await applySessionTitle(deps, { sessionId: 's-5', displayName: 'Reviewer', teamName: 'B1 Check', reason: 'member-renamed', previousTitle: 'Builder - B1 Check' })
    expect(deps.calls).toEqual([['s-5', 'Reviewer - B1 Check']])
    expect(result?.from).toBe('Builder - B1 Check')
    expect(result?.to).toBe('Reviewer - B1 Check')
  })
})
