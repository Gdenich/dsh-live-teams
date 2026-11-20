import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { agentRoleKind, agentRoleKinds, RoleAvatar } from './RoleAvatar.js'

describe('declared agent role icons', () => {
  it.each(agentRoleKinds)('renders a stable decorative %s icon beside the existing role text', role => {
    const html = renderToStaticMarkup(React.createElement(RoleAvatar, { role, label: role }))
    expect(html).toContain(`data-agent-role="${role}"`)
    expect(html).toContain(`data-agent-icon="${role}"`)
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('style=')
  })
  it('gives all built-in purposes distinct shapes, with a neutral custom fallback', () => {
    // Compare the SVG contents, not role-specific data attributes.
    const contents = agentRoleKinds.map(role => renderToStaticMarkup(React.createElement(RoleAvatar, { role, label: 'Role' })).replace(/^.*?<svg[^>]*>/u, '').replace(/<\/svg>.*$/u, ''))
    expect(new Set(contents).size).toBe(9)
    expect(agentRoleKind('custom-specialist')).toBe('custom')
    expect(agentRoleKind('Lead 2')).toBe('custom')
    expect(agentRoleKind('builder-for-review')).toBe('custom')
  })
  it('uses registry aliases but does not infer purpose from a descriptive custom role', () => {
    const roles = [{ id: 'builder', aliases: ['implementer'] }, { id: 'project-custom', aliases: ['auditor'] }]
    expect(agentRoleKind('implementer', roles)).toBe('builder')
    expect(agentRoleKind('auditor', roles)).toBe('custom')
    expect(agentRoleKind('BUILDER', roles)).toBe('builder')
    expect(agentRoleKind('researcher', [{ id: 'researcher' }])).toBe('researcher')
  })
  it('defines every categorical hue separately from Session state and preserves fallback neutrality', async () => {
    const { css } = await import('./styles.js')
    for (const role of agentRoleKinds.filter(role => role !== 'custom')) expect(css).toContain(`data-agent-role='${role}'] { --dsh-agent-hue:`)
    expect(css).not.toContain("data-agent-role='custom'] { --dsh-agent-hue:")
    expect(css).not.toMatch(/MemberAvatar[^\n]*data-status/u)
  })
})
