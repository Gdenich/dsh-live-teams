import React, { useEffect, useRef } from 'react'

/** A view-local modal drawer. It changes no routing, membership or request ownership. */
export function SidePanel(props: { title: string; closeLabel: string; onClose: () => void; busy?: boolean; children: React.ReactNode }): React.ReactElement {
  const panel = useRef<HTMLElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="dshLiveTeamsDrawerBackdrop" onClick={event => { if (event.target === event.currentTarget && !props.busy) props.onClose() }}>
    <aside ref={panel} className="dshLiveTeamsDrawer" tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.title} onKeyDown={event => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') { event.stopPropagation(); if (!props.busy) props.onClose(); return }
      if (event.key !== 'Tab') return
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])
      if (controls.length === 0) { event.preventDefault(); panel.current?.focus(); return }
      const first = controls[0]; const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <header className="dshLiveTeamsDrawerHeader"><h3>{props.title}</h3><button ref={close} type="button" className="dshLiveTeamsIconButton" aria-label={props.closeLabel} disabled={props.busy} onClick={props.onClose}>×</button></header>
      <div className="dshLiveTeamsDrawerBody">{props.children}</div>
    </aside>
  </div>
}
