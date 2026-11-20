import React, { type ErrorInfo, type ReactNode } from 'react'

/**
 * A panel that cannot render must say so, not vanish.
 *
 * The Team tab went blank on DSH 0.1.7 and the only trace was one line in the application log. A
 * blank tab tells a person nothing: not whether the plugin is missing, disabled, or crashing. React
 * throws while rendering a slot when a component it is given is `undefined` — a host rename does
 * exactly that — and the throw takes the whole slot with it.
 *
 * This boundary catches it and shows what happened, so the next rename reads as a sentence in the
 * panel instead of an empty space. The fallbacks in `primitives.ts` and `icons.ts` are the first
 * line of defence; this is the second, for anything they do not cover.
 */
type Props = { children?: ReactNode; label: string }
type State = { message?: string; stack?: string }

export class PanelErrorBoundary extends React.Component<Props, State> {
  override state: State = {}

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is where a developer looks; the panel is where the human looks. Both get it.
    console.error(`live-teams: the ${this.props.label} failed to render`, error, info.componentStack)
    const stack = info.componentStack
    this.setState(stack === null || stack === undefined ? {} : { stack })
  }

  override render(): ReactNode {
    if (this.state.message === undefined) return this.props.children
    return React.createElement('div', { className: 'dshLiveTeamsPanelError', role: 'alert' },
      React.createElement('strong', null, `live-teams: the ${this.props.label} could not be shown`),
      React.createElement('p', null, this.state.message),
      React.createElement('p', { className: 'dshLiveTeamsPanelErrorHint' },
        'This usually means the DSH version no longer exports something the panel needs. '
        + 'The host log line to look for is "slot entry crashed".'),
      this.state.stack === undefined
        ? null
        : React.createElement('pre', { className: 'dshLiveTeamsPanelErrorStack' }, this.state.stack.trim().split('\n').slice(0, 6).join('\n')),
    )
  }
}
