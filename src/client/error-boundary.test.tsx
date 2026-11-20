// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelErrorBoundary } from './error-boundary.js'

/**
 * The tab must never be blank.
 *
 * On DSH 0.1.7 a renamed icon made React throw while rendering the slot, and the human saw an empty
 * Team tab with no explanation. The boundary is the second line of defence: whatever the resolvers
 * miss, the panel shows a sentence and the error text instead of nothing.
 *
 * The child here throws the way React does for an undefined element type, and the boundary has to
 * catch it for real — not by being handed a state.
 */
const Boom = (): React.ReactElement => { throw new Error('element type is invalid: expected a string or a class/function but got: undefined') }

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => { act(() => { root?.unmount() }); container?.remove(); root = undefined; container = undefined })

describe('a panel that cannot render says so', () => {
  it('catches a throwing child and shows the error in the panel', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => {
        root?.render(React.createElement(PanelErrorBoundary, { label: 'team panel' }, React.createElement(Boom)))
      })
      const text = container.textContent ?? ''
      expect(text).toContain('team panel')
      expect(text).toContain('element type is invalid')
      expect(text).toContain('slot entry crashed')
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(consoleError).toHaveBeenCalled()
    } finally { consoleError.mockRestore() }
  })

  it('renders its children untouched when nothing throws', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(React.createElement(PanelErrorBoundary, { label: 'team panel' }, React.createElement('p', null, 'the team')))
    })
    expect(container.textContent).toBe('the team')
  })
})
