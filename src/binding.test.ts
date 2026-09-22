import { describe, expect, it } from 'vitest'
import { assertSessionInTeamWorkspace, canonicalPath } from './binding.js'
import type { SessionDescriptor } from './session-bridge.js'

const TEAM = '/tmp/live-teams-workspace'

function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    sessionId: 's-1',
    workspaceId: undefined,
    cwd: TEAM,
    title: undefined,
    status: 'unknown',
    live: false,
    subagentOwned: false,
    seq: 0,
    agentPreset: undefined,
    ...overrides,
  }
}

function bridgeOf(value: SessionDescriptor | undefined) {
  return { inspect: async () => value }
}

describe('workspace membership guard', () => {
  it('accepts a Session that works in the team workspace', async () => {
    const result = await assertSessionInTeamWorkspace({ bridge: bridgeOf(descriptor()), workspacePath: TEAM }, 's-1')
    expect(result.sessionId).toBe('s-1')
  })

  it('refuses a Session that works in another workspace', async () => {
    const other = descriptor({ cwd: '/tmp/somewhere-else' })
    await expect(assertSessionInTeamWorkspace({ bridge: bridgeOf(other), workspacePath: TEAM }, 's-1'))
      .rejects.toMatchObject({ code: 'SESSION_WRONG_WORKSPACE' })
  })

  it('compares canonical paths, so a symlinked spelling still matches', async () => {
    // /tmp is itself a symlink to /private/tmp on macOS.
    const canonical = canonicalPath(TEAM)
    const result = await assertSessionInTeamWorkspace(
      { bridge: bridgeOf(descriptor({ cwd: canonical })), workspacePath: TEAM },
      's-1',
    )
    expect(result.cwd).toBe(canonical)
  })

  it('reports a missing Session as not found rather than as a workspace mismatch', async () => {
    await expect(assertSessionInTeamWorkspace({ bridge: bridgeOf(undefined), workspacePath: TEAM }, 'gone'))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('refuses a subagent-owned Session', async () => {
    const owned = descriptor({ subagentOwned: true })
    await expect(assertSessionInTeamWorkspace({ bridge: bridgeOf(owned), workspacePath: TEAM }, 'child'))
      .rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })

  it('refuses a Session with no working directory to compare', async () => {
    const noCwd = descriptor({ cwd: undefined })
    await expect(assertSessionInTeamWorkspace({ bridge: bridgeOf(noCwd), workspacePath: TEAM }, 's-1'))
      .rejects.toMatchObject({ code: 'SESSION_WRONG_WORKSPACE' })
  })
})
