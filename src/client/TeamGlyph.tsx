import React from 'react'

/** Local decorative SVGs avoid extending the host primitive capability contract. */
export function TeamGlyph({ kind }: { kind: 'member' | 'task' | 'message' | 'review' | 'settings' | 'event' }): React.ReactElement {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === 'member' ? <><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-2a7 7 0 0 1 14 0v2Z" /></> : kind === 'message' ? <path d="M4 4h16v12H9l-5 4Z M8 8h8 M8 12h5" /> : kind === 'review' ? <><circle cx="12" cy="12" r="8" /><path d="m8 12 3 3 5-6" /></> : kind === 'settings' ? <><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></> : kind === 'task' ? <><path d="M6 3h9l4 4v14H6Z M15 3v5h4 M9 12h7 M9 16h5" /></> : <><path d="M5 12h14 M12 5l7 7-7 7" /></>}
  </svg>
}
