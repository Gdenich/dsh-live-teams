import React from 'react'

type RoleMetadata = { readonly id: string; readonly aliases?: readonly string[] }
export const agentRoleKinds = ['lead', 'builder', 'reviewer', 'verifier', 'oracle', 'researcher', 'scout', 'delegate', 'custom'] as const
export type AgentRoleKind = typeof agentRoleKinds[number]

/** Use the declared role/registry aliases only, never member names, notes or Session activity. */
export function agentRoleKind(role: string, roles: readonly RoleMetadata[] = []): AgentRoleKind {
  const key = role.trim().toLowerCase()
  const definition = roles.find(entry => entry.id.toLowerCase() === key) ?? roles.find(entry => entry.aliases?.some(alias => alias.toLowerCase() === key))
  const canonical = definition?.id.toLowerCase() ?? key
  return (agentRoleKinds as readonly string[]).includes(canonical) ? canonical as AgentRoleKind : 'custom'
}

export function RoleAvatar({ role, label, roles }: { role: string; label: string; roles?: readonly RoleMetadata[] }): React.ReactElement {
  const kind = agentRoleKind(role, roles)
  return <span className="dshLiveTeamsMemberAvatar" data-agent-role={kind} title={label} aria-hidden="true">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false" data-agent-icon={kind}>
      {kind === 'lead' ? <><rect x="9" y="3" width="6" height="5" rx="1" /><path d="M12 8v5M5 13h14M5 13v3M19 13v3" /><rect x="2" y="16" width="6" height="5" rx="1" /><rect x="16" y="16" width="6" height="5" rx="1" /></>
        : kind === 'builder' ? <><path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16" /></>
        : kind === 'reviewer' ? <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>
        : kind === 'verifier' ? <><circle cx="10" cy="10" r="7" /><path d="m7 10 2 2 4-4M15 15l6 6" /></>
        : kind === 'oracle' ? <><path d="M9 17h6M9 20h6M12 2a6 6 0 0 0-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 0 0-4-10Z" /></>
        : kind === 'researcher' ? <><path d="M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3ZM12 6v15M6 8h3M6 12h3M15 8h3M15 12h3" /></>
        : kind === 'scout' ? <><circle cx="12" cy="12" r="9" /><path d="m16 8-2 6-6 2 2-6ZM12 2v2M22 12h-2M12 22v-2M2 12h2" /></>
        : kind === 'delegate' ? <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /><path d="M9 6h9v6m-3-3 3 3 3-3M6 9v9h6m-3-3 3 3-3 3" /></>
        : <><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-2a7 7 0 0 1 14 0v2Z" /></>}
    </svg>
  </span>
}
