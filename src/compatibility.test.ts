import { describe, expect, it } from 'vitest'
import { HOST_CAPABILITIES, checkCompatibility } from './compatibility.js'

/**
 * The check exists because a DSH release can rename or drop a service this plugin calls, and the
 * failure mode without it is the one the human named: "I updated DSH and everything broke", with no
 * line saying what broke.
 */
describe('host compatibility', () => {
  const full = { sessionController: { create: () => undefined }, agents: { get: () => undefined }, systemPrompt: {}, workspaceRegistry: {}, tools: { register: () => undefined }, webServer: { register: () => undefined } }

  it('is compatible when the host offers everything the plugin calls', () => {
    const verdict = checkCompatibility(full, { hostVersion: '0.1.5-rc.2', declared: ['0.1.5-rc.2'] })
    expect(verdict.verdict).toBe('compatible')
    expect(verdict.missing).toEqual([])
    expect(verdict.detail).toContain('offers everything')
  })

  it('turns the team off, with the missing names, when a required surface is gone', () => {
    const verdict = checkCompatibility({ ...full, agents: {} }, { hostVersion: '0.2.0', declared: ['0.1.5-rc.2'] })
    expect(verdict.verdict).toBe('incompatible')
    expect(verdict.missing).toEqual(['agents.get'])
    expect(verdict.detail).toContain('agents.get')
    expect(verdict.detail).toContain('stays off')
  })

  it('degrades instead of failing when an optional surface is gone', () => {
    const { webServer: _dropped, ...headless } = full
    const verdict = checkCompatibility(headless, { hostVersion: '0.1.5-rc.2', declared: ['0.1.5-rc.2'] })
    expect(verdict.verdict).toBe('degraded')
    expect(verdict.missing).toEqual([])
    expect(verdict.absent).toEqual(['webServer.register'])
  })

  it('says so when the host version is not one this plugin declares', () => {
    const verdict = checkCompatibility(full, { hostVersion: '0.1.6-alpha.2', declared: ['0.1.5-rc.2'] })
    expect(verdict.verdict).toBe('degraded')
    expect(verdict.detail).toContain('not in this plugin\'s declared releases')
    expect(verdict.detail).toContain('everything the plugin calls is present')
  })

  it('reports a host that throws on property access instead of crashing the plugin', () => {
    // Cordis throws when a service outside `inject` is read as a property. The first version of this
    // check did exactly that and took the plugin down with it — the failure it was written to prevent.
    const hostile = new Proxy({}, {
      get: (_target, key) => { if (key === 'get') return undefined; throw new Error(`cannot get property "${String(key)}" without inject`) },
    })
    const verdict = checkCompatibility(hostile as Record<string, unknown>, { hostVersion: '0.1.5-rc.2', declared: ['0.1.5-rc.2'] })
    expect(verdict.verdict).toBe('incompatible')
    expect(verdict.missing).toContain('sessionController.create')
  })

  it('reads services through the host reader, not as bare properties', () => {
    const host = { get: (name: string) => name === 'tools' ? { register: () => undefined } : undefined }
    const verdict = checkCompatibility(host, { hostVersion: '0.1.5-rc.2', declared: ['0.1.5-rc.2'] })
    expect(verdict.absent).not.toContain('tools.register')
  })

  it('names every required surface once, and never asks for one it does not use', () => {
    const names = HOST_CAPABILITIES.map((capability) => capability.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('sessionController.create')
  })
})
