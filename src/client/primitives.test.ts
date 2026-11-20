import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * A host component that disappears must degrade, not take the panel down.
 *
 * This is the failure the Team tab died of: a name the host no longer exports is `undefined`, and
 * React throws "element type is invalid" for the whole slot. The resolver has fallbacks for exactly
 * that, and this test drives the real path — a mocked host that is missing a component.
 */
describe('a missing host component degrades instead of crashing', () => {
  it('renders its fallback when the host does not export it', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-client-ui-primitives', () => ({
      // Everything the panel needs except Button and Modal: the two that matter here.
      MarkdownText: () => React.createElement('div', { className: 'markdown-text' }),
      StateDot: () => React.createElement('span'),
      Tag: () => React.createElement('span'),
      Tooltip: () => React.createElement('span'),
    }))
    const primitives = await import('./primitives.js')
    expect(primitives.resolvedFromHost()).toEqual(['MarkdownText', 'StateDot', 'Tag', 'Tooltip'])

    const button = renderToStaticMarkup(React.createElement(primitives.Button, { className: 'x' }, 'Save'))
    expect(button).toContain('data-live-teams-fallback="Button"')
    expect(button).toContain('Save')

    // A closed fallback dialog renders nothing; an open one still shows its content.
    expect(renderToStaticMarkup(React.createElement(primitives.Modal, { open: false }))).toBe('')
    const dialog = renderToStaticMarkup(React.createElement(primitives.Modal, { open: true, title: 'Add member' }, 'body'))
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('body')
    vi.doUnmock('@deepseek-ai/dsh-client-ui-primitives')
    vi.resetModules()
  })
})
