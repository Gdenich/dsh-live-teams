// @vitest-environment happy-dom
/**
 * Structural checks on the rendered Team view.
 *
 * The client had two defects that no logic test could catch — a status marker
 * painted outside its clipped container, and actions that vanished after being
 * used — so the role panel is pinned here against real DOM output rather than
 * against the shape of the data it is built from.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// React only flushes act() work when the environment announces itself.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The primitive package ships CSS modules and imports dependencies it does not
 * declare, which only exist inside the host application, so it cannot be loaded
 * from this package's own test run. The stand-ins below mirror what those
 * primitives render — an element with the given children — which is all these
 * structural assertions depend on. They deliberately do not test the primitives
 * themselves.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const element = (tag: string) => (props: Record<string, unknown>) =>
    React.createElement(tag, { className: props.className, onClick: props.onClick, disabled: props.disabled, 'aria-label': props['aria-label'] }, (props.children ?? null) as React.ReactNode)
  return {
    Button: element('button'),
    // The real component renders markdown; the test only needs to see that the body reached it.
    MarkdownText: (props: Record<string, unknown>) => React.createElement('div', { className: 'markdown-text' }, String(props.text ?? '')),
    Tag: element('span'),
    StateDot: () => React.createElement('span', { className: 'state-dot' }),
    Tooltip: element('span'),
    Modal: (props: Record<string, unknown>) => (props.open === true ? React.createElement('div', { role: 'dialog', 'aria-label': props.title }, props.description as React.ReactNode, props.children as React.ReactNode, props.footer as React.ReactNode) : null),
    // The names the host uses now. The panel resolves icons at runtime, so the mock has to speak the
    // same language as the real module: a mock still exporting the old names would hide the break.
    IconEditOutlineRegular: () => React.createElement('span'),
    IconPlusOutlineRegular: () => React.createElement('span'),
    IconPauseOutlineRegular: () => React.createElement('span'),
    IconPlayOutlineRegular: () => React.createElement('span'),
    IconRefreshOutlineRegular: () => React.createElement('span'),
    IconChevronDownOutlineRegular: () => React.createElement('span', { 'data-testid': 'task-chevron' }),
  }
})

const { TeamView, taskStatusKeys, taskFilterKeys, messageKindKeys, attemptStatusKeys } = await import('./TeamView.js')

const snapshot = {
  teamId: 'team-1',
  teamName: 'B1 Check',
  workspacePath: '/w',
  revision: 3,
  members: [
    {
      memberId: 'm-1', displayName: 'Build', role: 'builder', note: 'implements', availability: 'available',
      sessionId: 'session-1', live: true, status: 'running', bindingGeneration: 0, contractRevision: 0,
    },
  ],
}

const taskFixture = {
  // A task in `waiting` has a submission nobody has decided on: the panel reads that fact, not the
  // status, so the fixture carries it too.
  tasks: { teamId: 'team-1', tasks: [{ id: 'task-1', title: 'Build report', status: 'waiting', awaitsDecision: true, assignee: 'm-1', assigneeName: 'Build', route: { type: 'report', to: 'human' }, round: 2, roundLimit: 5, updatedAt: Date.now() }] },
  detail: { task: { id: 'task-1', teamId: 'team-1', title: 'Build report', kind: 'implementation', status: 'waiting', activeAttemptId: 'attempt-1', assignee: 'm-1', route: { type: 'report', to: 'human' }, acceptance: ['Tests pass'], roundLimit: 5, createdBy: 'm-1', createdAt: 1, updatedAt: 2, revision: 1 }, document: '# Build report', submissions: [{ id: 'sub-1', taskId: 'task-1', attemptId: 'attempt-1', attemptGeneration: 1, artifact: { type: 'report', bodyRef: 'report.md', bodyDigest: 'digest' }, summary: 'done', checks: [{ command: 'test', status: 'passed' }], scope: { state: 'shared-tree', declared: ['packages/alpha/**'], changed: ['packages/alpha/src/a.js', 'packages/beta/src/b.js'], unexpected: ['packages/beta/src/b.js'], sharedTree: ['packages/beta/src/b.js'] }, createdAt: 2, revision: 1 }], rounds: [{ id: 'round-1', taskId: 'task-1', submissionId: 'sub-1', reviewerMemberId: 'm-1', round: 2, verdict: 'needs_revision', findings: [{ severity: 'low', problem: 'minor', requiredFix: 'fix' }], evidence: [], createdAt: 3, revision: 1 }], attempts: [{ id: 'attempt-1', memberId: 'm-1', sessionId: 'session-1', generation: 1, status: 'active', startedAt: 2, humanIntervenedAt: 3 }] },
}

const roles = {
  roles: [
    { id: 'builder', name: 'Builder', description: 'Builds.', source: 'workspace', aliases: [], overridden: true },
    { id: 'oracle', name: 'Oracle', description: 'Advises.', source: 'global', aliases: [], overridden: false },
  ],
  globalDirectory: '/pkg/roles',
  workspaceDirectory: '/w/.dsh-live-teams/roles',
  workspaceDirectoryExists: true,
  openAvailable: true,
  globalOpenAvailable: true,
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.unstubAllGlobals()
})

async function renderView(payload: { ctx?: unknown; pollMs?: number; snapshot?: unknown; roles?: unknown; attention?: unknown; rolesStatus?: number; candidates?: unknown; team?: unknown; messages?: unknown; journal?: unknown; tasks?: unknown; taskDetail?: unknown; taskActionStatus?: number; taskActionError?: string; taskQuiesced?: boolean; interruptStatus?: number; messageSendStatus?: number; messageSendError?: string; grantStatus?: number; grantError?: string; dispatch?: unknown; dispatchStatus?: number; fetchCalls?: Array<{ url: string; method: string; body?: string }>; candidatesNeverResolves?: boolean } = {}): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (payload.fetchCalls !== undefined) payload.fetchCalls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    // `/team/lead` resolves the lead (state, then a single lead-role member); the
    // team status deliberately does not carry it. Mirror that split here.
    if (url.includes('/api/live-teams/team/lead')) {
      const snap = payload.snapshot as { leadMemberId?: string; members?: Array<{ memberId: string; role: string }> } | undefined
      const fromRole = snap?.members?.filter((member) => member.role === 'lead')
      const leadMemberId = fromRole?.length === 1 ? fromRole[0]?.memberId : undefined
      return new Response(JSON.stringify({ ...(leadMemberId === undefined ? {} : { leadMemberId }), resolvedFrom: leadMemberId === undefined ? 'none' : 'state' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/team')) {
      const state = payload.team ?? { enabled: true, teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', revision: 3, memberCount: 1, briefing: 'Order text', openAvailable: true }
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/journal')) {
      return new Response(JSON.stringify(payload.journal ?? { teamId: 'team-1', entries: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/roles')) {
      if (payload.rolesStatus !== undefined && payload.rolesStatus !== 200) {
        return new Response(JSON.stringify({ error: 'live-teams state unavailable' }), { status: payload.rolesStatus, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(payload.roles ?? roles), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/member/interrupt')) {
      const status = payload.interruptStatus ?? 200
      return new Response(JSON.stringify(status === 409 ? { error: 'live-teams member has no running turn' } : { memberId: 'm-1', interrupted: true, status: 'idle' }), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/member/grant')) {
      const status = payload.grantStatus ?? 200
      return new Response(JSON.stringify(status === 200 ? { grants: [] } : { error: payload.grantError ?? 'server grant refusal' }), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/api/live-teams/messages' && method === 'POST') {
      const status = payload.messageSendStatus ?? 200
      return new Response(JSON.stringify(status === 200 ? { accepted: true, messageId: 'msg-sent', recipients: ['m-1'], deliveries: [{ id: 'd-sent', recipient: 'm-1', state: 'delivered' }] } : { error: payload.messageSendError ?? 'server send refusal' }), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/task/cancel')) {
      const quiesced = payload.taskQuiesced ?? true
      return new Response(JSON.stringify({ task: { ...taskFixture.detail.task, status: quiesced ? 'cancelled' : 'needs_human' }, quiesced, ...(quiesced ? { archivedPath: 'archive/task-1.md' } : {}) }), { status: 200 })
    }
    if (url.includes('/api/live-teams/task/resume')) return new Response(JSON.stringify({ task: { ...taskFixture.detail.task, status: 'ready' } }), { status: 200 })
    if (url.includes('/api/live-teams/task/create')) return new Response(JSON.stringify({ task: taskFixture.detail.task, documentPath: '/w/task-1.md', warnings: [{ code: 'path-no-match', pattern: 'packages/a/**', message: 'New path or typo' }] }), { status: 200 })
    if (url.includes('/api/live-teams/task/update')) return new Response(JSON.stringify({ task: taskFixture.detail.task, document: '# Build report', changed: ['title'] }), { status: 200 })
    if (url.includes('/api/live-teams/task/revoke')) return new Response(JSON.stringify({ task: { ...taskFixture.detail.task, status: 'draft' }, attempt: { ...taskFixture.detail.attempts[0], status: 'revoked' }, quiesced: true, reassigned: false }), { status: 200 })
    if (url.includes('/api/live-teams/task/accept') || url.includes('/api/live-teams/task/revise')) {
      const status = payload.taskActionStatus ?? 200
      return new Response(JSON.stringify(status === 200 ? { task: { ...taskFixture.detail.task, status: url.includes('/accept') ? 'completed' : 'in_progress' }, archivedPath: '/archive/task.md' } : { error: payload.taskActionError ?? 'server task refusal' }), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/dispatch')) {
      const status = payload.dispatchStatus ?? 200
      if (method === 'POST') return new Response(JSON.stringify({ from: 'paused', to: 'auto' }), { status, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify(status === 200 ? payload.dispatch ?? idleDispatch : { error: 'live-teams dispatch unavailable' }), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/task?')) return new Response(JSON.stringify(payload.taskDetail ?? taskFixture.detail), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/live-teams/tasks')) return new Response(JSON.stringify(payload.tasks ?? taskFixture.tasks), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/live-teams/messages')) {
      return new Response(JSON.stringify(payload.messages ?? { teamId: 'team-1', messages: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/live-teams/attention')) return new Response(JSON.stringify(payload.attention ?? { teamId: 'team-1', attention: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/live-teams/candidates')) return new Response(JSON.stringify(payload.candidates ?? { teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', revision: 3, candidates: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(payload.snapshot ?? snapshot), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props = (payload.ctx === undefined && payload.pollMs === undefined)
    ? {}
    : ({ ...(payload.ctx === undefined ? {} : { ctx: payload.ctx }), ...(payload.pollMs === undefined ? {} : { pollMs: payload.pollMs }) } as Parameters<typeof TeamView>[0])
  await act(async () => { root?.render(React.createElement(TeamView, props)) })
  // The view asks for the team state first and only then for members and roles,
  // so settle every follow-up fetch before asserting on the result.
  for (let tick = 0; tick < 20; tick += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
  }
  return container
}

async function openSettings(view: HTMLElement): Promise<void> {
  await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsSettingsToggle')?.click() })
}

const idleDispatch = {
  teamId: 'team-1', paused: false, coding: 'manual', counts: { assign: 0, active: 0, wait: 0, refused: 0 },
  tasks: [{ taskId: 'task-1', title: 'Build report', status: 'waiting', assignee: 'm-1', decision: 'wait', reason: 'human-gate', detail: 'the member is waiting for an answer' }],
}

describe('member settings hierarchy', () => {
  it('distinguishes a reported empty contact list from missing contact metadata', async () => {
    const view = await renderView({ snapshot: { ...snapshot, members: [{ ...snapshot.members[0], permittedContacts: [] }] } })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    expect(view.querySelector('.dshLiveTeamsContactChips')?.textContent).toBe('noPeerContact')
    expect(view.querySelector('.dshLiveTeamsContactChips')?.textContent).not.toContain('memberContactsUnknown')
  })
  it('marks a role draft without applying it or recoloring the committed profile', async () => {
    const fetchCalls: Array<{ url: string; method: string }> = []
    const view = await renderView({ fetchCalls })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const role = view.querySelector<HTMLSelectElement>('.dshLiveTeamsMemberSettings .dshLiveTeamsRoleInput')!
    await act(async () => { role.value = 'oracle'; role.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(view.querySelector('.dshLiveTeamsDraftHint')?.textContent).toBe('memberRolePending')
    expect(view.querySelector('.dshLiveTeamsMemberSettings .dshLiveTeamsMemberAvatar')?.getAttribute('data-agent-role')).toBe('builder')
    expect(fetchCalls.every(call => call.method === 'GET')).toBe(true)
  })
  it('does not mistake unavailable contact/turn metadata for denied contacts or an idle turn', async () => {
    const view = await renderView({ snapshot: { ...snapshot, members: [{ ...snapshot.members[0], note: undefined, status: 'unknown', sessionId: null }] } })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const panel = view.querySelector('.dshLiveTeamsMemberSettings')!
    expect(panel.querySelector('.dshLiveTeamsContactChips')?.textContent).toContain('memberContactsUnknown')
    expect(panel.querySelector('.dshLiveTeamsContactChips')?.textContent).not.toContain('noPeerContact')
    expect(panel.querySelector('[data-member-section="session"]')?.textContent).toContain('memberTurnUnknown')
    expect(panel.querySelector('.dshLiveTeamsInterruptButton')).toBeNull()
    expect(panel.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberOpen')?.disabled).toBe(true)
    expect(panel.querySelector('[data-member-section="note"]')).toBeNull()
    expect(panel.querySelector<HTMLDetailsElement>('.dshLiveTeamsMemberTechnical')?.open).toBe(false)
  })
  it('pauses assignments without invoking Session interruption and retains the revision guard', async () => {
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = []
    const view = await renderView({ fetchCalls })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    expect(view.querySelector('[data-member-section="availability"]')?.textContent).toContain('memberAvailabilityHint')
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsAvailabilityAction')?.click() })
    const mutation = fetchCalls.find(call => call.method === 'POST' && call.url.includes('/members/availability'))
    expect(JSON.parse(mutation?.body ?? '{}')).toMatchObject({ memberId: 'm-1', availability: 'paused', expectedRevision: 3 })
    expect(fetchCalls.some(call => call.url.includes('/member/interrupt'))).toBe(false)
  })
  it('updates Session/contact snapshots while keeping unsaved role and name drafts', async () => {
    const payload: Parameters<typeof renderView>[0] = { pollMs: 25, snapshot: { ...snapshot, members: [{ ...snapshot.members[0], permittedContacts: ['human'] }] } }
    const view = await renderView(payload)
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const role = view.querySelector<HTMLSelectElement>('.dshLiveTeamsMemberPanel .dshLiveTeamsRoleInput')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(role, 'oracle'); role.dispatchEvent(new Event('change', { bubbles: true })); view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberPanel .dshLiveTeamsEditNameButton')?.click() })
    const name = view.querySelector<HTMLInputElement>('.dshLiveTeamsMemberPanel .dshLiveTeamsNameInput')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'Unsaved name'); name.dispatchEvent(new Event('input', { bubbles: true })) })
    payload.snapshot = { ...snapshot, revision: 4, members: [{ ...snapshot.members[0], status: 'idle', permittedContacts: ['team'] }] }
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsOverviewActions .dshLiveTeamsIconButton')?.click(); await new Promise(resolve => setTimeout(resolve, 5)) })
    expect(view.querySelector('.dshLiveTeamsMemberPanel .dshLiveTeamsStateLabel')?.textContent).toContain('idle')
    expect(view.querySelector('.dshLiveTeamsContactChips')?.textContent).toContain('memberContactTeam')
    expect(role.value).toBe('oracle')
    expect(name.value).toBe('Unsaved name')
  })
})

describe('task-first Team interactions', () => {  it('colors role icons from declared purpose, not display name or running state', async () => {
    const fetchCalls: Array<{ url: string; method: string }> = []
    const members = [
      { ...snapshot.members[0], memberId: 'purpose-1', displayName: 'Lead in name only', role: 'builder', status: 'running' },
      { ...snapshot.members[0], memberId: 'purpose-2', displayName: 'Builder in name only', role: 'lead', status: 'idle' },
      { ...snapshot.members[0], memberId: 'purpose-3', displayName: 'Review', role: 'reviewer', status: 'unknown' },
      { ...snapshot.members[0], memberId: 'purpose-4', displayName: 'Custom', role: 'project-custom', status: 'running' },
    ]
    const view = await renderView({ fetchCalls, snapshot: { ...snapshot, members }, tasks: { teamId: 'team-1', tasks: [] } })
    const rows = Array.from(view.querySelectorAll('.dshLiveTeamsRow'))
    expect(rows.map(row => row.querySelector('.dshLiveTeamsMemberAvatar')?.getAttribute('data-agent-role'))).toEqual(['builder', 'lead', 'reviewer', 'custom'])
    expect(rows[0]?.querySelector('.dshLiveTeamsMemberLive')?.textContent).toContain('running')
    expect(rows[1]?.querySelector('.dshLiveTeamsMemberLive')?.textContent).toContain('idle')
    expect(rows[2]?.querySelector('.dshLiveTeamsMemberLive')?.textContent).toContain('unknown')
    expect(fetchCalls.every(call => call.method === 'GET')).toBe(true)
  })
  it('explains an empty active filter when all known tasks are archived without switching filters or mutating data', async () => {
    const fetchCalls: Array<{ url: string; method: string }> = []
    const view = await renderView({ fetchCalls, tasks: { teamId: 'team-1', tasks: [{ ...taskFixture.tasks.tasks[0], status: 'completed', title: 'Closed evidence', archivedPath: '/archive/x' }] } })
    expect(view.querySelector('.dshLiveTeamsTaskEmpty')?.textContent).toContain('tasksEmpty')
    expect(view.querySelectorAll('.dshLiveTeamsTaskRow')).toHaveLength(0)
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[2]?.click() })
    expect(view.querySelector('.dshLiveTeamsTaskEmpty')).toBeNull()
    expect(view.querySelector('.dshLiveTeamsTaskRow')?.textContent).toContain('Closed evidence')
    expect(fetchCalls.every(call => call.method === 'GET')).toBe(true)
  })
  it('keeps long typed references out of the activity heading but retains full source and emphasis on disclosure', async () => {
    const title = 'Evidence task with long typed metadata '.repeat(12)
    const summary = `Reviewer accepted · ${title}`
    const view = await renderView({ journal: { teamId: 'team-1', entries: [{ id: 'long-row', kind: 'task/accepted', category: 'task', at: 1, summary, summaryParts: [{ text: 'Reviewer', strong: true }, { text: ` accepted · ${title}` }], refs: { taskTitle: title } }] } })
    const row = view.querySelector('.dshLiveTeamsJournalRow')!
    expect(row.querySelector('.dshLiveTeamsJournalSummary')?.textContent).toBe('Reviewer accepted')
    expect(row.querySelector('.dshLiveTeamsJournalSummary strong')?.textContent).toBe('Reviewer')
    expect(row.querySelector('.dshLiveTeamsJournalTaskRef')?.getAttribute('title')).toBe(title)
    await act(async () => { row.querySelector<HTMLButtonElement>('.dshLiveTeamsJournalLine')?.click() })
    expect(row.querySelector('.dshLiveTeamsJournalSourceSummary')?.textContent).toBe(summary)
  })
  it('avoids placeholder noise without inferring work from a live Session', async () => {
    const view = await renderView({ tasks: { teamId: 'team-1', tasks: [] }, snapshot: { ...snapshot, members: [{ ...snapshot.members[0], note: undefined }] } })
    const row = view.querySelector('.dshLiveTeamsRow')!
    expect(row.textContent).not.toContain('noNote')
    expect(row.textContent).toContain('noAssignedTask')
    expect(row.querySelector('.dshLiveTeamsMemberLive')?.textContent).toContain('running')
    expect(row.querySelector('svg')).not.toBeNull()
  })
  it('keeps a representative multi-member task-first view read-only and supports offline visual inspection', async () => {
    const fetchCalls: Array<{ url: string; method: string }> = []
    const names = ['Lead', 'Builder 1', 'Builder 2', 'Reviewer 1', 'Reviewer 2']
    const members = names.map((displayName, index) => ({ ...snapshot.members[0], memberId: `m-${index + 1}`, displayName, role: index === 0 ? 'lead' : index < 3 ? 'builder' : 'reviewer', status: index === 0 || index === 2 ? 'running' : 'idle', permittedContacts: index === 0 ? ['m-2', 'm-3', 'm-4', 'm-5', 'team', 'human'] : ['m-1'], note: index === 0 ? 'Coordinates the existing contract' : undefined }))
    const tasks = [
      { ...taskFixture.tasks.tasks[0], id: 'layout-1', title: 'Preserve delivery semantics while improving the workspace team interface', status: 'in_progress', awaitsDecision: false, assigneeName: 'Builder 1', assignee: 'm-2' },
      { ...taskFixture.tasks.tasks[0], id: 'layout-2', title: 'Verify responsive task details and keyboard access', status: 'ready', awaitsDecision: false, assigneeName: 'Builder 2', assignee: 'm-3' },
      { ...taskFixture.tasks.tasks[0], id: 'layout-3', title: 'Review the submitted evidence without repeating acceptance', assigneeName: 'Builder 1', assignee: 'm-2', route: { type: 'review', reviewer: 'm-4', reviewerName: 'Reviewer 1' } },
    ]
    const { dictionaries } = await import('./locales.js')
    const en = dictionaries.en
    const view = await renderView({ fetchCalls, ctx: { t: (key: keyof typeof en) => en[key] }, roles: { ...roles, roles: [...roles.roles, { ...roles.roles[0], id: 'lead', name: 'Lead', description: 'Coordinates the team and maintains its operating order.' }, { ...roles.roles[0], id: 'reviewer', name: 'Reviewer', description: 'Reviews submitted work against the contract.' }] }, snapshot: { ...snapshot, members }, tasks: { teamId: 'team-1', tasks }, journal: { teamId: 'team-1', entries: [
      { id: 'layout-j1', kind: 'task/submitted', category: 'task', at: 1700000010000, summary: 'Builder 1 submitted evidence for review', refs: { taskTitle: 'Review the submitted evidence', round: 1 } },
      { id: 'layout-j2', kind: 'review/pass', category: 'review', at: 1700000009000, summary: 'Reviewer 2 recorded PASS; Lead notification is a separate delivery', refs: {} },
      { id: 'layout-j3', kind: 'delivery/queued', category: 'delivery', at: 1700000008000, summary: 'Native admission is not execution', refs: {} },
    ] } })
    expect(view.querySelectorAll('.dshLiveTeamsRow')).toHaveLength(5)
    expect(view.querySelectorAll('.dshLiveTeamsTaskRow')).toHaveLength(2)
    if (process.env.LIVE_TEAMS_VISUAL_DIR !== undefined) {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { resolve } = await import('node:path')
      const directory = resolve(process.env.LIVE_TEAMS_VISUAL_DIR)
      if (!directory.startsWith('/tmp/team-ui-visual-')) throw new Error('visual output must be an owned temporary fixture')
      await mkdir(directory, { recursive: true })
      const { css } = await import('./styles.js')
      const theme = ':root{--dsw-alias-label-primary:#e5e7eb;--dsw-alias-label-secondary:#a2a6af;--dsw-alias-label-tertiary:#777e89;--dsw-alias-bg-layer-1:#1b1d22;--dsw-alias-bg-layer-2:#21242a;--dsw-alias-border-l2:#343840;--dsw-alias-border-l1:#555c68;--dsw-alias-brand-primary:#7a9cfd;--dsw-alias-button-primary-fill:#537fe2;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-interactive-bg-hover:#2d323b;--dsw-alias-state-error-primary:#e38786;--dsw-alias-state-warn-primary:#dab275;--dsw-alias-state-success-primary:#86bb9b}body{margin:0;background:#15171b;font-family:system-ui,sans-serif;height:100vh}body>main{height:100%;max-width:1200px;margin:auto}button,select,input,textarea{font-family:inherit}'
      const save = async (name: string) => writeFile(`${directory}/${name}.html`, `<!doctype html><meta charset="utf-8"><title>Synthetic Team UI fixture — not the installed GUI</title><style>${theme}${css}</style><main>${view.innerHTML}</main>`)
      await save('overview')
      await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
      await save('waiting')
      await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[0]?.click() })
      await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
      await save('member')
      await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberSettings .dshLiveTeamsEditNameButton')?.click() })
      await save('member-edit')
      await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsDrawerHeader button')?.click() })
      await openSettings(view)
      await save('settings')
    }
    expect(fetchCalls.every(call => call.method === 'GET')).toBe(true)
  })
  it('keeps settings hidden until requested and restores focus after Escape without a mutation', async () => {
    const fetchCalls: Array<{ url: string; method: string }> = []
    const view = await renderView({ fetchCalls })
    const button = view.querySelector<HTMLButtonElement>('.dshLiveTeamsSettingsToggle')!
    expect(view.querySelector('.dshLiveTeamsTeamControls')).toBeNull()
    button.focus()
    await openSettings(view)
    const drawer = view.querySelector<HTMLElement>('.dshLiveTeamsDrawer')!
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(drawer.querySelector('.dshLiveTeamsLeadControl')).not.toBeNull()
    expect(document.activeElement).toBe(drawer.querySelector('.dshLiveTeamsDrawerHeader button'))
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(view.querySelector('.dshLiveTeamsDrawer')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(fetchCalls.every(call => call.method === 'GET')).toBe(true)
  })
  it('traps member-panel keyboard focus, closes with Escape and preserves assignment truth', async () => {
    const view = await renderView({ tasks: taskFixture.tasks })
    const button = view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')!
    expect(button.textContent).toContain('assignedTasks: Build report')
    button.focus()
    await act(async () => { button.click() })
    const drawer = view.querySelector<HTMLElement>('.dshLiveTeamsDrawer')!
    const close = drawer.querySelector<HTMLButtonElement>('.dshLiveTeamsDrawerHeader button')!
    const last = drawer.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberRemove')!
    await act(async () => { close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(last)
    await act(async () => { last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(close)
    await act(async () => { close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(view.querySelector('.dshLiveTeamsMemberPanel')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
  it('keeps important failures visible, retains all technical events and discloses raw event kinds', async () => {
    const fetchCalls: Array<{ url: string; method: string }> = []
    const view = await renderView({ fetchCalls, journal: { teamId: 'team-1', entries: [
      { id: 'j1', kind: 'task/created', category: 'task', at: 1, summary: 'Formal work saved', refs: {} },
      { id: 'j2', kind: 'delivery/queued', category: 'delivery', at: 2, summary: 'Ordinary transport', refs: {} },
      { id: 'j3', kind: 'delivery/failed', category: 'delivery', at: 3, summary: 'Actionable transport failure', refs: {} },
    ] } })
    const list = () => view.querySelector('.dshLiveTeamsJournalList')!
    expect(list().textContent).toContain('Formal work saved')
    expect(list().textContent).toContain('Actionable transport failure')
    expect(list().textContent).not.toContain('Ordinary transport')
    expect(list().textContent).not.toContain('task/created')
    await act(async () => { Array.from(list().querySelectorAll<HTMLButtonElement>('.dshLiveTeamsJournalLine')).find(button => button.textContent?.includes('Formal work saved'))?.click() })
    expect(list().textContent).toContain('task/created')
    const mode = (text: string) => Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsActivityModes button')).find(button => button.textContent === text)!
    await act(async () => { mode('journalAll').click() })
    expect(list().querySelectorAll('.dshLiveTeamsJournalRow')).toHaveLength(3)
    await act(async () => { mode('journalTechnical').click() })
    expect(list().textContent).not.toContain('Formal work saved')
    expect(list().querySelectorAll('.dshLiveTeamsJournalRow')).toHaveLength(2)
    expect(fetchCalls.every(call => call.method === 'GET')).toBe(true)
  })
})

describe('journal read failure visibility', () => {
  it('does not claim there is no activity when the initial journal response is invalid', async () => {
    const view = await renderView({ journal: { teamId: 'team-1', entries: 'not-an-array' } })
    const journal = view.querySelector('.dshLiveTeamsJournal')
    expect(journal?.textContent).not.toContain('journalEmpty')
    expect(journal?.querySelector('.dshLiveTeamsNotice')?.textContent).toContain('invalid team response')
  })

  it('retains good journal entries during a failed poll and clears the notice on recovery', async () => {
    const payload: Parameters<typeof renderView>[0] = { pollMs: 25, journal: { teamId: 'team-1', entries: [{ id: 'e-1', kind: 'task/created', category: 'task', at: 1, summary: 'A stored task event', refs: {}, fields: [] }] } }
    const view = await renderView(payload)
    payload.journal = { teamId: 'team-1', entries: 'not-an-array' }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    const journal = view.querySelector('.dshLiveTeamsJournal')
    expect(journal?.textContent).toContain('A stored task event')
    expect(journal?.querySelector('.dshLiveTeamsNotice')?.textContent).toContain('invalid team response')
    payload.journal = { teamId: 'team-1', entries: [] }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    expect(journal?.querySelector('.dshLiveTeamsNotice')).toBeNull()
    expect(journal?.textContent).toContain('A stored task event')
  })
})

describe('review return visibility', () => {
  it.each([['failed', 'needs_human'], ['blocked', 'waiting']])('offers explicit return but not acceptance after %s', async (state, status) => {
    const reviewReturn = { roundId: 'r1', submissionId: 'sub1', attemptId: 'attempt-1', generation: 1, assignee: 'm-1', sessionId: 's-1', bindingGeneration: 1, state, at: 1 }
    const view = await renderView({ tasks: { teamId: 'team-1', tasks: [{ ...taskFixture.tasks.tasks[0], status, awaitsDecision: false, reviewReturn }] }, taskDetail: { ...taskFixture.detail, task: { ...taskFixture.detail.task, status, reviewReturn } } })
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click(); })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    const actions = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskActions button')).map(button => button.textContent)
    expect(actions).toContain('taskRevise')
    expect(actions).not.toContain('taskAccept')
  })
  it.each(['pending', 'sending', 'delivered', 'started', 'completed', 'blocked', 'failed', 'unconfirmed', 'superseded'])('shows %s independently of the task progress badge', async state => {
    const reviewReturn = { roundId: 'r1', submissionId: 'sub1', attemptId: 'attempt-1', generation: 1, assignee: 'm-1', sessionId: 's-1', bindingGeneration: 1, state, at: 1, messageId: 'msg1', requestId: 'req1', turn: 1, inputSeq: 2, leadNotified: false }
    const view = await renderView({ tasks: { teamId: 'team-1', tasks: [{ ...taskFixture.tasks.tasks[0], status: 'in_progress', awaitsDecision: false, reviewReturn }] }, taskDetail: { ...taskFixture.detail, task: { ...taskFixture.detail.task, status: 'in_progress', reviewReturn } } })
    expect(view.querySelector('[data-review-return-state]')?.textContent).toContain(`reviewReturn${state}`)
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    expect(view.querySelector('.dshLiveTeamsTaskDetail')?.textContent).toContain(`reviewReturn${state}`)
    const text = view.querySelector('.dshLiveTeamsTaskDetail')?.textContent
    if (['started', 'completed', 'blocked', 'failed'].includes(state)) expect(text).toContain('reviewReturnLeadPending')
    else expect(text).not.toContain('reviewReturnLeadPending')
  })
})

describe('repaired lifecycle controls', () => {
  it.each([true, false])('shows the actual cancellation outcome (quiesced=%s)', async (quiesced) => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const view = await renderView({ tasks: taskFixture.tasks, taskDetail: taskFixture.detail, taskQuiesced: quiesced, fetchCalls: calls })
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    const close = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskActions button')).find((button) => button.textContent === 'taskClose')
    expect(close).toBeDefined()
    await act(async () => { close?.click() })
    let submit = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === 'taskClose')
    expect(submit?.disabled).toBe(true)
    const reason = view.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
    expect(reason).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, 'obsolete task')
      reason?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    submit = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === 'taskClose')
    expect(submit?.disabled).toBe(false)
    await act(async () => { submit?.click() })
    expect(calls.some((call) => call.url.includes('/task/cancel') && call.method === 'POST')).toBe(true)
    expect(view.querySelector('[role="dialog"]')).toBeNull()
    expect(view.textContent).not.toContain('invalid team response')
    if (!quiesced) expect(view.textContent).toContain('taskStopUnconfirmed')
  })

  it('offers an explicit restart for parked work and sends the restart request', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const view = await renderView({ tasks: { teamId: 'team-1', tasks: [{ ...taskFixture.tasks.tasks[0], status: 'draft', awaitsDecision: false }] }, taskDetail: { ...taskFixture.detail, task: { ...taskFixture.detail.task, status: 'draft', activeAttemptId: undefined }, attempts: [{ ...taskFixture.detail.attempts[0], status: 'revoked' }] }, fetchCalls: calls })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    const restart = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskActions button')).find((button) => button.textContent === 'taskResume')
    expect(restart).toBeDefined()
    await act(async () => { restart?.click() })
    expect(calls.some((call) => call.url.includes('/task/resume') && call.method === 'POST')).toBe(true)
    expect(view.textContent).toContain('taskResumed')
    expect(view.textContent).not.toContain('invalid team response')
  })
})

describe('B29 dispatch surface', () => {
  const pausedDispatch = {
    teamId: 'team-1', paused: true, coding: 'manual', pausedBy: 'human:desktop', pausedReason: 'stand maintenance',
    counts: { assign: 0, active: 0, wait: 1, refused: 0 },
    tasks: [{ taskId: 'task-1', title: 'Build report', status: 'ready', assignee: 'm-1', decision: 'wait', reason: 'member-paused', detail: 'Build is paused' }],
  }
  const readyTasks = { teamId: 'team-1', tasks: [{ id: 'task-1', title: 'Build report', status: 'ready', assignee: 'm-1', assigneeName: 'Build', route: { type: 'report', to: 'human' }, roundLimit: 5, updatedAt: Date.now() }] }

  it('marks the paused team, offers to resume, and names the reason on the row', async () => {
    const container = await renderView({ dispatch: pausedDispatch, tasks: readyTasks })
    // No host translator is mounted here, so the view renders the key itself —
    // the same convention the other structural checks follow.
    expect(container.querySelector('.dshLiveTeamsNotice')?.textContent).toContain('dispatchPaused')
    expect(container.querySelector('.dshLiveTeamsNotice')?.textContent).toContain('stand maintenance')
    expect(container.querySelector('.dshLiveTeamsDispatchTogglePaused')).not.toBeNull()
    expect(container.querySelector('.dshLiveTeamsDispatchToggle')?.textContent).toContain('dispatchResume')
    const chip = container.querySelector('.dshLiveTeamsTaskQueued')
    expect(chip?.textContent).toBe('taskQueuedMemberPaused')
    expect(chip?.getAttribute('title')).toBe('Build is paused')
  })

  it('shows who holds an attempt, and marks one a human wrote into', async () => {
    const container = await renderView({ tasks: taskFixture.tasks, taskDetail: taskFixture.detail })
    // The task is `waiting`, so it lives behind the second filter.
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
    const row = container.querySelector('.dshLiveTeamsTaskRow')
    await act(async () => { row?.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    for (let tick = 0; tick < 20; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    const attempts = container.querySelector('.dshLiveTeamsTaskAttempts')
    expect(attempts?.textContent).toContain('Build')
    expect(attempts?.textContent).toContain('attemptStatusactive')
    const mark = container.querySelector('.dshLiveTeamsTaskIntervened')
    expect(mark?.textContent).toBe('taskIntervened')
    expect(mark?.getAttribute('title')).toBe('attemptHumanIntervened')
  })

  it('never flashes the journal into a loading state while polling', async () => {
    // The first version of the poll re-set the loading flag on every tick, and the journal
    // card blinked every four seconds. A MutationObserver catches that: any added node
    // carrying the loading class is a regression, even if it disappears before the end.
    const journal = { teamId: 'team-1', entries: [{ id: 'journal-1', kind: 'task/created', category: 'task', at: Date.now(), summary: 'created', refs: {} }] }
    const view = await renderView({ journal, pollMs: 20 })
    expect(view.querySelector('.dshLiveTeamsJournalList')).not.toBeNull()
    const flashes: string[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLElement && node.classList.contains('dshLiveTeamsMessage')) flashes.push(node.textContent ?? '')
        }
      }
    })
    observer.observe(view, { childList: true, subtree: true })
    for (let tick = 0; tick < 40; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    observer.disconnect()
    expect(flashes).toEqual([])
    expect(view.querySelector('.dshLiveTeamsJournalList')).not.toBeNull()
  })

  it('re-reads itself while visible, so a finished task leaves Active without a reload', async () => {
    // The human's report: tasks arrived and finished, but the list only changed after a
    // filter switch or a page reload. The tab now polls while it is visible.
    const tasks = { teamId: 'team-1', tasks: [{ id: 'task-1', title: 'Build report', status: 'in_progress', assignee: 'm-1', assigneeName: 'Build', route: { type: 'report', to: 'human' }, round: 0, roundLimit: 5, updatedAt: 1 }] }
    const view = await renderView({ tasks, pollMs: 20 })
    expect(view.querySelector('.dshLiveTeamsTaskRow')?.textContent).toContain('taskStatusin_progress')
    tasks.tasks[0]!.status = 'completed'
    for (let tick = 0; tick < 40; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    // No user action at all: the polling read the new state and the Active filter dropped it.
    expect(view.querySelector('.dshLiveTeamsTaskRow')).toBeNull()
  })

  it('says which evidence the scope record came from, and why it is unchecked (B32)', async () => {
    const detail = {
      ...taskFixture.detail,
      submissions: [{ ...taskFixture.detail.submissions[0], scope: { state: 'unchecked', reason: 'no-repository', declared: ['packages/alpha/**'] } }],
    }
    const container = await renderView({ tasks: taskFixture.tasks, taskDetail: detail })
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
    const row = container.querySelector('.dshLiveTeamsTaskRow')
    await act(async () => { row?.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    for (let tick = 0; tick < 20; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    const scope = container.querySelector('.dshLiveTeamsSubmissionScope')
    expect(scope?.textContent).toBe('scopeUnchecked')
    // "I could not look" must not read as "nothing happened".
    expect(scope?.getAttribute('title')).toContain('scopeReasonNoRepository')
  })

  it('shows what the declaration was worth at submission, in plain words', async () => {
    const container = await renderView({ tasks: taskFixture.tasks, taskDetail: taskFixture.detail })
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
    const row = container.querySelector('.dshLiveTeamsTaskRow')
    await act(async () => { row?.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    for (let tick = 0; tick < 20; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    const scope = container.querySelector('.dshLiveTeamsSubmissionScope')
    expect(scope?.textContent).toBe('scopeSharedTree')
    // The tooltip names the paths and says who was writing there — an observation, not
    // an accusation (a shared tree moves under everybody).
    expect(scope?.getAttribute('title')).toContain('packages/beta/src/b.js')
    expect(scope?.getAttribute('title')).toContain('scopeSharedTreeNote')
    expect(scope?.getAttribute('title')).toContain('scopeDeclared: packages/alpha/**')
  })

  it('gives the member panel an explicit way into the member Session', async () => {
    // The panel asks for the behaviour, not for a service by name: the host moved session opening
    // from `sessions.open` (0.1.5) to `uiWorkspace.openSession` (0.1.7), and a call to the wrong one
    // throws inside a click handler, where no error boundary can catch it.
    const openSession = vi.fn(() => true)
    const view = await renderView({ ctx: { openSession, t: (key: string) => key } })
    const row = view.querySelector<HTMLElement>('.dshLiveTeamsRow')
    await act(async () => { row?.querySelector<HTMLElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const open = view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberOpen')
    expect(open?.textContent).toBe('openSessionAction')
    expect(open?.disabled).toBe(false)
    await act(async () => { open?.click() })
    expect(openSession).toHaveBeenCalledWith('session-1')
  })

  it('says why coding work is not started on its own', async () => {
    const container = await renderView({
      tasks: { teamId: 'team-1', tasks: [{ id: 'task-1', title: 'Write the code', status: 'ready', assignee: 'm-1', assigneeName: 'Build', route: { type: 'report', to: 'human' }, roundLimit: 5, updatedAt: Date.now() }] },
      dispatch: { ...idleDispatch, tasks: [{ taskId: 'task-1', title: 'Write the code', status: 'ready', assignee: 'm-1', decision: 'wait', reason: 'coding-not-isolated', detail: 'implementation work is not started automatically until this deployment allows coding dispatch without worktree isolation (ADR 0008)' }] },
    })
    const chip = container.querySelector('.dshLiveTeamsTaskQueued')
    expect(chip?.textContent).toBe('taskQueuedCoding')
    expect(chip?.getAttribute('title')).toContain('ADR 0008')
  })

  it('says nothing about dispatch for a task the human is already deciding', async () => {
    const container = await renderView({ tasks: taskFixture.tasks })
    expect(container.querySelector('.dshLiveTeamsTaskQueued')).toBeNull()
    expect(container.querySelector('.dshLiveTeamsDispatchToggle')?.textContent).toContain('dispatchPause')
  })

  it('posts the target mode when the human flips the switch', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const container = await renderView({ dispatch: pausedDispatch, tasks: readyTasks, fetchCalls: calls })
    const toggle = container.querySelector('.dshLiveTeamsDispatchToggle') as HTMLButtonElement
    await act(async () => { toggle.click() })
    for (let tick = 0; tick < 20; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)) })
    const posted = calls.find((call) => call.url.includes('/api/live-teams/dispatch') && call.method === 'POST')
    expect(posted?.body).toContain('"mode":"auto"')
  })
})

describe('B24 stylesheet contract', () => {
  it('contains the recipe frame, tiles, task scale, host tokens and no inline or hex styles', async () => {
    const { css } = await import('./styles.js')
    expect(css).toContain('padding: 16px 20px 32px')
    expect(css).toContain('box-sizing: border-box')
    expect(css).toContain('height: 100%')
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('background: var(--dsw-alias-bg-layer-1)')
    expect(css).toContain('border: 1px solid var(--dsw-alias-border-l2)')
    // The markdown component reads the application's reading-size tokens (14px base, 21px headings),
    // which is right for a chat message and too big for a journal row. The journal re-points the
    // tokens instead of fighting its selectors.
    expect(css).toContain('--dsw-font-markdown-base')
    expect(css).toContain('--dsh-content-font-size: 11px')
    // The journal takes the height it can; 320px showed eight rows and hid the rest.
    expect(css).toContain('max-height: min(58vh, 760px)')
    // The inbox panel is wider than the application's confirmation modal (380px).
    expect(css).toContain('width: min(760px, 92vw)')
    expect(css).toContain('border-radius: 10px')
    expect(css).toContain('.dshLiveTeamsRoot .dshLiveTeamsCard')
    expect(css).toContain('margin-bottom: 7px')
    expect(css).toContain('padding: 7px 8px')
    expect(css).toContain('display: flex;')
    expect(css).toContain('flex-wrap: wrap')
    expect(css).toContain('gap: 7px')
    expect(css).toContain('repeat(auto-fit, minmax(108px, 1fr))')
    expect(css).toContain('padding: 6px 3px')
    expect(css).toContain('font-size: 14px')
    expect(css).toContain('grid-template-columns: 14px auto minmax(0, 1fr) minmax(0, 1.2fr) 36px 42px')
    expect(css).toContain('padding: 1px 6px')
    expect(css).toContain('font-size: 10px')
    expect(css).toContain('max-height: 320px')
    expect(css).toContain('var(--ds-transition-duration, .2s)')
    expect(css).toContain('var(--ds-ease-in-out, ease-in-out)')
    expect(css).toContain('dsh-context')
    expect(css).toContain('Apache License 2.0')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i)
  })
})

describe('locale coverage', () => {
  it('keeps locale dictionaries and typed translation maps complete', async () => {
    const { dictionaries } = await import('./locales.js')
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.ru).sort())
    for (const dictionary of Object.values(dictionaries)) {
      for (const key of Object.values(taskStatusKeys)) expect(dictionary[key]).toBeTruthy()
      for (const key of Object.values(attemptStatusKeys)) expect(dictionary[key]).toBeTruthy()
      for (const key of Object.values(taskFilterKeys)) expect(dictionary[key]).toBeTruthy()
      for (const key of Object.values(messageKindKeys)) expect(dictionary[key]).toBeTruthy()
    }
  })
})

describe('B23 task surface', () => {
  it('renders collapsed task facts without actions and expands details', async () => {
    const view = await renderView({ tasks: taskFixture.tasks, taskDetail: taskFixture.detail })
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
    const row = view.querySelector('.dshLiveTeamsTaskRow')
    expect(row?.querySelector('.dshLiveTeamsTaskStatus')?.textContent).toContain('taskAwaitingHuman')
    expect(row?.querySelector('.dshLiveTeamsTaskStatus')?.getAttribute('title')).toBe('taskStatuswaiting')
    expect(row?.textContent).toContain('Build report')
    expect(row?.textContent).toContain('report → human')
    expect(row?.textContent).toContain('2/5')
    expect(row?.querySelector('.dshLiveTeamsTaskSummary button')).toBeNull()
    await act(async () => { row?.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    expect(view.querySelector('.dshLiveTeamsTaskDetail')?.textContent).toContain('# Build report')
    expect(view.querySelector('.dshLiveTeamsTaskDetail')?.textContent).toContain('needs_revision')
    expect(view.querySelector('.dshLiveTeamsTaskActions button')).not.toBeNull()
  })
  it('switches filters and shows refusal text from server', async () => {
    const view = await renderView({ tasks: { teamId: 'team-1', tasks: [...taskFixture.tasks.tasks, { ...taskFixture.tasks.tasks[0], id: 'task-archived', title: 'Archived', status: 'completed', archivedPath: '/archive/a' }] }, taskActionStatus: 400, taskActionError: 'server task refusal', taskDetail: taskFixture.detail })
    const filters = view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')
    expect(filters).toHaveLength(3)
    await act(async () => { filters[2]?.click() })
    expect(view.textContent).toContain('Archived')
    await act(async () => { filters[1]?.click() })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    // Named, not positional: the actions block now also carries "release attempt", and a
    // first-child selector quietly clicked the wrong one.
    const accept = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskActions button')).find((button) => button.textContent === 'taskAccept')
    await act(async () => { accept?.click() })
    const confirm = view.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')
    await act(async () => { confirm?.click() })
    expect(view.textContent).toContain('server task refusal')
  })
  it('lets the human create a task and release an attempt from the panel (review finding 4)', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const view = await renderView({ tasks: taskFixture.tasks, taskDetail: taskFixture.detail, fetchCalls: calls })
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskNew')?.click() })
    const draft = view.querySelector('[role="dialog"]')
    // The title sits outside the dialog element; the description identifies the form.
    expect(draft?.textContent).toContain('taskDraftDescription')
    // The form has its own labels: `title` in this panel means the team, and reusing it put
    // "Workspace team" above the task name (the human saw exactly that on the stand).
    expect(draft?.textContent).toContain('taskTitleLabel')
    expect(draft?.textContent).not.toContain('Workspace team')
    // Every control sits in a field wrapper and the fields sit in the styled container: a select or
    // textarea outside them is a native control, which is what the human saw.
    expect(draft?.querySelectorAll('.dshLiveTeamsModalFields .dshLiveTeamsModalField').length).toBeGreaterThanOrEqual(8)
    expect(draft?.querySelector('.dshLiveTeamsModalFields select')).not.toBeNull()
    expect(draft?.querySelector('.dshLiveTeamsModalFields textarea')).not.toBeNull()
    // The action is shaped like the segments it sits beside, not like a standalone outline button.
    const newTask = view.querySelector('.dshLiveTeamsTaskNew')
    expect(newTask?.tagName).toBe('BUTTON')
    expect(newTask?.className).not.toContain('dshLiveTeamsSegmentedButtonActive')
    // Located by label, not by index: the form gained fields once already, and an index-based test
    // filled the wrong ones and then failed on a disabled button.
    const field = (key: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined => {
      const label = Array.from(draft?.querySelectorAll('label') ?? []).find((entry) => entry.textContent?.includes(key))
      return label?.querySelector('input, textarea, select') ?? undefined
    }
    const set = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined, value: string): void => {
      if (element === undefined) return
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await act(async () => {
      set(field('taskTitleLabel'), 'From the panel')
      set(field('taskPaths'), 'packages/a/**')
      set(field('taskAcceptanceLabel'), 'it works')
    })
    const save = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).at(-1)
    await act(async () => { save?.click() })
    expect(calls.some((call) => call.url.includes('/api/live-teams/task/create') && call.method === 'POST' && String(call.body).includes('From the panel'))).toBe(true)
    expect(view.querySelector('[role="dialog"]')).toBeNull()
    expect(view.textContent).toContain('taskSaved')
    expect(view.textContent).toContain('taskPathNoMatch')
    expect(view.textContent).toContain('packages/a/**')

    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    const release = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskActions button')).find((button) => button.textContent === 'taskRelease')
    expect(release).toBeDefined()
    await act(async () => { release?.click() })
    const reason = view.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')
    await act(async () => {
      if (reason !== null) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, 'the human stopped it')
        reason.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    const confirm = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).at(-1)
    await act(async () => { confirm?.click() })
    expect(calls.some((call) => call.url.includes('/api/live-teams/task/revoke') && String(call.body).includes('the human stopped it'))).toBe(true)
    expect(view.querySelector('.dshLiveTeamsTaskDetail')).toBeNull()
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    expect(calls.filter((call) => call.url.includes('/api/live-teams/task?'))).toHaveLength(2)
  })

  it('renders the fixed round column and host chevron without nested actions', async () => {
    const view = await renderView({ tasks: taskFixture.tasks })
    await act(async () => { view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsTaskFilterButton')[1]?.click() })
    const row = view.querySelector('.dshLiveTeamsTaskRow')
    expect(row?.querySelector('.dshLiveTeamsTaskSummary')?.querySelectorAll('button')).toHaveLength(0)
    expect(row?.querySelector('.dshLiveTeamsTaskRound')?.textContent).toContain('2/5')
    expect((row?.querySelector('.dshLiveTeamsTaskRound') as HTMLElement | null)?.className).toContain('dshLiveTeamsTaskRound')
    expect(row?.querySelector('[data-testid="task-chevron"]')).not.toBeNull()
    await act(async () => { row?.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskSummary')?.click() })
    expect(row?.querySelector('.dshLiveTeamsTaskDisclosureOpen')).not.toBeNull()
  })

  /**
   * "ready" is not the same as "can be started": B26 exists so that a blocked task
   * never looks like a claimable one.
   */
  it('marks a blocked task and names what blocks it', async () => {
    const view = await renderView({ tasks: { teamId: 'team-1', tasks: [
      { ...taskFixture.tasks.tasks[0], id: 'task-ready', status: 'ready', round: undefined },
      { ...taskFixture.tasks.tasks[0], id: 'task-blocked', title: 'Build on the schema', status: 'ready', round: undefined, dependsOn: ['task-schema'], blockedBy: [{ id: 'task-schema', title: 'Publish the schema', status: 'in_progress' }] },
    ] } })
    const blocked = view.querySelector<HTMLButtonElement>('.dshLiveTeamsTaskRow:nth-child(2) .dshLiveTeamsTaskSummary')
    expect(blocked?.querySelector('.dshLiveTeamsTaskBlocked')?.textContent).toContain('taskBlocked')
    expect(blocked?.querySelector('.dshLiveTeamsTaskBlocked')?.getAttribute('title')).toContain('Publish the schema')
    // An unblocked row carries no marker at all.
    expect(view.querySelector('.dshLiveTeamsTaskRow:nth-child(1) .dshLiveTeamsTaskBlocked')).toBeNull()
  })

  it('renders six overview tiles, including task counts', async () => {
    const view = await renderView({ tasks: { teamId: 'team-1', tasks: [
      { ...taskFixture.tasks.tasks[0], status: 'waiting' },
      { ...taskFixture.tasks.tasks[0], id: 'task-ready', status: 'ready' },
      { ...taskFixture.tasks.tasks[0], id: 'task-archived', status: 'completed', archivedPath: '/archive/a' },
    ] } })
    const tiles = view.querySelectorAll('.dshLiveTeamsStat')
    expect(tiles).toHaveLength(6)
    expect(tiles[4]?.textContent).toContain('activeTasks')
    expect(tiles[4]?.textContent).toContain('1')
    expect(tiles[5]?.textContent).toContain('awaitingLead')
    expect(tiles[5]?.textContent).toContain('1')
  })

  it('renders the journal row contract, 320px scroll region, and multi-category filters', async () => {
    const view = await renderView({ journal: { teamId: 'team-1', entries: [
      { id: 'j-1', kind: 'task/created', category: 'task', at: 1700000000000, summary: 'created Build report', refs: { taskId: 'task-1', taskTitle: 'Build report', round: 2 } },
      { id: 'j-2', kind: 'message/sent', category: 'message', at: 1700000001000, summary: 'sent hello', refs: {}, detail: 'hello' },
    ] } })
    const list = view.querySelector<HTMLElement>('.dshLiveTeamsJournalList')
    expect(list).not.toBeNull()
    expect(list?.textContent).toContain('created Build report')
    expect(list?.textContent).toContain('task-1')
    expect(list?.textContent).toContain('journalRound 2')
    expect(list?.textContent).toContain('hello')
    expect((list?.className ?? '')).toContain('dshLiveTeamsJournalList')
    const filters = view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsJournalFilter')
    expect(filters).toHaveLength(8)
    await act(async () => { filters[0]?.click(); filters[1]?.click() })
    expect(view.querySelector('.dshLiveTeamsJournalList')?.textContent).toContain('sent hello')
  })

  it('keeps compact cells free of mutation controls and opens selected-member management in a drawer', async () => {
    const view = await renderView()
    const row = view.querySelector<HTMLElement>('.dshLiveTeamsRow')
    expect(row?.querySelectorAll('select, input')).toHaveLength(0)
    expect(row?.querySelectorAll('button')).toHaveLength(1)
    expect(row?.querySelector('button')?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(row?.textContent).toContain('Build')
    expect(row?.querySelector('.dshLiveTeamsMemberChip')?.textContent).toBe('Builder')
    expect(row?.querySelector('button')?.title).toBe('available')
    expect(row?.textContent).toContain('implements')
    // The live marker is a real glyph: a literal "\u25cf" escape in the markup
    // renders as six visible characters and no structural test notices.
    expect(row?.querySelector('.dshLiveTeamsMemberLive')?.textContent).toContain('●')
    expect(view.querySelector('.dshLiveTeamsMemberPanel')).toBeNull()
    await act(async () => { row?.querySelector<HTMLElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    // The unfolding controls are a sibling of the ribbon, so the compact cell
    // keeps its width and the other members keep their places.
    const panel = view.querySelector<HTMLElement>('.dshLiveTeamsMemberPanel')
    expect(panel).not.toBeNull()
    expect(row?.querySelector('select')).toBeNull()
    expect(panel?.querySelector('select')).not.toBeNull()
    expect(panel?.querySelector('.dshLiveTeamsMemberRemove')).not.toBeNull()
    // Name editing is one click away and lands in the same compact panel.
    await act(async () => { panel?.querySelector<HTMLButtonElement>('.dshLiveTeamsEditNameButton')?.click() })
    expect(view.querySelector('.dshLiveTeamsMemberPanel .dshLiveTeamsNameInput')).not.toBeNull()
  })

  it('separates profile, role, assignments, contacts, Session, details and removal', async () => {
    const view = await renderView()
    await act(async () => { view.querySelector<HTMLElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const panel = view.querySelector<HTMLElement>('.dshLiveTeamsMemberSettings')!
    expect(panel).toBeTruthy()
    expect(Array.from(panel.querySelectorAll('[data-member-section]')).map(node => node.getAttribute('data-member-section'))).toEqual(['role', 'availability', 'contacts', 'session', 'note', 'technical', 'removal'])
    const identity = panel.querySelector('.dshLiveTeamsMemberIdentity')!
    expect(identity.querySelector('.dshLiveTeamsMemberName')?.textContent).toBe('Build')
    expect(panel.querySelector('.dshLiveTeamsMemberHeading .dshLiveTeamsMemberAvatar')).not.toBeNull()
    expect(identity.querySelector('.dshLiveTeamsEditNameButton')).not.toBeNull()
    expect(identity.querySelector('.dshLiveTeamsState')).not.toBeNull()
    expect(panel.querySelector('[data-member-section="availability"] .dshLiveTeamsAvailabilityAction')?.textContent).toContain('memberPauseAssignments')
    expect(panel.querySelector('[data-member-section="session"] .dshLiveTeamsInterruptButton')).not.toBeNull()
    expect(panel.querySelector('[data-member-section="session"] .dshLiveTeamsMemberOpen')).not.toBeNull()
    expect(panel.querySelector<HTMLDetailsElement>('.dshLiveTeamsMemberTechnical')?.open).toBe(false)
    expect(panel.querySelector('[data-member-section="removal"] .dshLiveTeamsMemberRemove')).not.toBeNull()
  })

  it('opens one member panel at a time so the ribbon never grows into a wall', async () => {
    const view = await renderView()
    const toggle = (index: number) => view.querySelectorAll<HTMLElement>('.dshLiveTeamsMemberCollapsed')[index]
    await act(async () => { toggle(0)?.click() })
    expect(view.querySelectorAll('.dshLiveTeamsMemberPanel')).toHaveLength(1)
    await act(async () => { toggle(0)?.click() })
    expect(view.querySelectorAll('.dshLiveTeamsMemberPanel')).toHaveLength(0)
  })

  it('collapses Briefing and Roles by default and expands each on demand', async () => {
    const view = await renderView()
    await openSettings(view)
    expect(view.querySelector('.dshLiveTeamsBriefing')?.querySelector('pre')).toBeNull()
    expect(view.querySelector('.dshLiveTeamsRoles')?.querySelector('.dshLiveTeamsRoleRow')).toBeNull()
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsBriefing .dshLiveTeamsCollapseHeader')?.click(); view.querySelector<HTMLButtonElement>('.dshLiveTeamsRoles .dshLiveTeamsCollapseHeader')?.click() })
    expect(view.querySelector('.dshLiveTeamsBriefing pre')).not.toBeNull()
    expect(view.querySelector('.dshLiveTeamsRoles .dshLiveTeamsRoleRow')).not.toBeNull()
  })

  it('renders tasks first and full width, then compact members and activity, with settings hidden', async () => {
    const view = await renderView({ tasks: taskFixture.tasks })
    const main = view.querySelector('.dshLiveTeamsMain')
    expect(Array.from(main?.children ?? []).map(node => node.className)).toEqual([
      'dshLiveTeamsCard dshLiveTeamsTasks dshLiveTeamsListPanel',
      'dshLiveTeamsCard dshLiveTeamsMembers',
      'dshLiveTeamsCard dshLiveTeamsJournal',
    ])
    expect(view.querySelector('.dshLiveTeamsHead .dshLiveTeamsSummary')).not.toBeNull()
    expect(view.querySelector('.dshLiveTeamsTeamControls')).toBeNull()
    expect(view.querySelector('.dshLiveTeamsMainLeft, .dshLiveTeamsMainRight')).toBeNull()
    expect(main?.querySelector('.dshLiveTeamsJournal .dshLiveTeamsInboxButton')).not.toBeNull()
    expect(main?.querySelector('.dshLiveTeamsTasks .dshLiveTeamsTaskFilter')).not.toBeNull()
    const { css } = await import('./styles.js')
    expect(css).toContain('.dshLiveTeamsTaskFirst .dshLiveTeamsMain { display: grid; grid-template-columns: minmax(0, 1fr);')
    expect(css).toContain('.dshLiveTeamsDrawerBackdrop { position: fixed;')
    expect(css).toContain('@container dshLiveTeamsCard (max-width: 700px)')
  })

  it('keeps the message composer behind the inbox control until requested', async () => {
    const view = await renderView()
    // Nothing of the inbox is in the panel until it is asked for: it opens over the journal.
    expect(view.querySelector('.dshLiveTeamsComposer')).toBeNull()
    expect(view.querySelector('.dshLiveTeamsInbox')).toBeNull()
    const toggle = view.querySelector<HTMLButtonElement>('.dshLiveTeamsInboxButton')
    expect(toggle).not.toBeNull()
    await act(async () => { toggle?.click() })
    expect(view.querySelector('.dshLiveTeamsComposer')).not.toBeNull()
    expect(view.querySelector('.dshLiveTeamsInbox')).not.toBeNull()
    // It opens in a panel of its own, not in the application's 380px confirmation card: an agent's
    // report does not fit there (the human saw it squeezed into a column).
    const dialog = view.querySelector('.dshLiveTeamsDialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('.dshLiveTeamsDialogBody .dshLiveTeamsInbox')).not.toBeNull()
    expect(dialog?.querySelector('.dshLiveTeamsDialogHead')).not.toBeNull()
  })
})

describe('opening a member session survives the host moving the API', () => {
  it('uses uiWorkspace.openSession when the host offers it', async () => {
    // DSH 0.1.7 removed `sessions.open` and opens sessions through `uiWorkspace.openSession`;
    // 0.1.5 is the other way round. The click used to throw inside the handler, where no error
    // boundary can see it, so the button simply did nothing.
    const opened: string[] = []
    const view = await renderView({ ctx: { openSession: (id: string) => { opened.push(id); return true }, t: (key: string) => key } })
    // The button lives in the expanded member panel, as the neighbouring test shows.
    await act(async () => { view.querySelector<HTMLElement>('.dshLiveTeamsRow .dshLiveTeamsMemberCollapsed')?.click() })
    const open = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'openSessionAction')
    await act(async () => { open?.click() })
    expect(opened).toEqual(['session-1'])
  })

  it('says so when the host offers no way at all', async () => {
    const view = await renderView({ ctx: { openSession: () => false, t: (key: string) => key } })
    await act(async () => { view.querySelector<HTMLElement>('.dshLiveTeamsRow .dshLiveTeamsMemberCollapsed')?.click() })
    const open = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'openSessionAction')
    await act(async () => { open?.click() })
    expect(view.textContent).toContain('openSessionUnavailable')
  })
})

describe('add member empty state', () => {
  it('shows creation fields and action when there are no candidates', async () => {
    const view = await renderView()
    const add = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => (button.getAttribute('aria-label') ?? '') === 'addMember')
    await act(async () => { add?.click() })
    expect(view.querySelector('input[type="text"]')).not.toBeNull()
    expect(view.querySelector('select')).not.toBeNull()
    expect(view.textContent).toContain('createMember')
    expect(view.textContent).toContain('candidatesEmpty')
  })

  it('keeps candidate selection behavior when candidates exist', async () => {
    const view = await renderView({ candidates: { teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', revision: 3, candidates: [{ sessionId: 'candidate-1', title: 'Candidate', cwd: '/w', live: false, status: 'idle' }] } })
    const add = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => (button.getAttribute('aria-label') ?? '') === 'addMember')
    await act(async () => { add?.click() })
    expect(view.querySelector('.dshLiveTeamsCandidateList')).not.toBeNull()
    expect(view.textContent).toContain('Candidate')
  })
})

describe('add member session choice', () => {
  const candidates = { teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', revision: 3, candidates: [{ sessionId: 'candidate-1', title: 'Builder - B1 Check', cwd: '/w', live: false, status: 'idle' as const }] }

  /**
   * React tracks a controlled input's last value on the node itself, so a plain
   * `node.value = text` is swallowed as "no change". The native setter bypasses
   * the tracker and lets the dispatched event reach onChange.
   */
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const setInputValue = (node: HTMLInputElement | null, value: string): void => {
    if (node === null) return
    nativeValueSetter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const openDialog = async (view: HTMLElement): Promise<void> => {
    const add = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => (button.getAttribute('aria-label') ?? '') === 'addMember')
    await act(async () => { add?.click() })
  }
  const radioRows = (view: HTMLElement): HTMLInputElement[] => Array.from(view.querySelectorAll<HTMLInputElement>('.dshLiveTeamsCandidateList input[type="radio"]'))

  it('offers a New session row beside the listed Sessions', async () => {
    const view = await renderView({ candidates })
    await openDialog(view)
    const rows = radioRows(view)
    expect(rows).toHaveLength(2)
    expect(view.textContent).toContain('candidateNewSession')
    expect(rows[0]?.checked).toBe(true)
  })

  it('switches to creating a Session and clears the name it prefilled itself', async () => {
    const view = await renderView({ candidates })
    await openDialog(view)
    const name = view.querySelector<HTMLInputElement>('.dshLiveTeamsAddForm input[type="text"]')
    expect(name?.value).toBe('Builder')
    await act(async () => { radioRows(view)[1]?.click() })
    expect(radioRows(view)[1]?.checked).toBe(true)
    expect(name?.value).toBe('')
  })

  it('keeps a name the human typed when switching to a new Session', async () => {
    const view = await renderView({ candidates })
    await openDialog(view)
    const name = view.querySelector<HTMLInputElement>('.dshLiveTeamsAddForm input[type="text"]')
    await act(async () => { setInputValue(name, 'Scout') })
    await act(async () => { radioRows(view)[1]?.click() })
    expect(name?.value).toBe('Scout')
  })

  it('selects New session by default when nothing is free to join', async () => {
    const view = await renderView()
    await openDialog(view)
    const rows = radioRows(view)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.checked).toBe(true)
  })
})

describe('adding a member does not wait for the candidate list', () => {
  it('enables Create for a new Session while the candidate list is still loading', async () => {
    // The list is for binding a Session that already exists. Waiting for it disabled the button for
    // the new-Session path too, and a list that never arrives left the human with a dead button and
    // no message — which is exactly what happened on the stand.
    const payload: { candidatesNeverResolves?: boolean; fetchCalls?: Array<{ url: string; method: string }> } = { candidatesNeverResolves: true, fetchCalls: [] }
    const view = await renderView(payload)
    const add = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => (button.getAttribute('aria-label') ?? '') === 'addMember')
    await act(async () => { add?.click() })
    // The list never answers; the button for the new-Session path must be usable anyway. Asserting
    // the loading text would only measure a microtask, and the point is the button.
    // React tracks a controlled node's last value, so a plain assignment is swallowed as "no
    // change": the native setter bypasses the tracker, as the neighbouring tests do it.
    const setNative = (node: HTMLInputElement | HTMLSelectElement | null, value: string, event: 'input' | 'change'): void => {
      if (node === null) return
      const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, value)
      node.dispatchEvent(new Event(event, { bubbles: true }))
    }
    await act(async () => {
      setNative(view.querySelector<HTMLInputElement>('input[type="text"]'), 'Panel Builder', 'input')
      // The first select in the panel is the lead chooser; the role select lives in the dialog.
      setNative(view.querySelector<HTMLSelectElement>('.dshLiveTeamsModalField select'), 'builder', 'change')
    })
    // The roles arrive from their own request: one more turn of the loop before judging the button.
    await act(async () => { await Promise.resolve() })
    const save = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'createMember')
    expect(save?.disabled).toBe(false)

    // And the click does something even when the snapshot has not arrived: it fetches the revision it
    // writes against instead of returning silently, which is what made the button look dead.
    const calls = payload.fetchCalls ?? []
    await act(async () => { save?.click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.some((call) => call.url.includes('/api/live-teams/members') && call.method === 'POST')).toBe(true)
  })
})

describe('the activity journal unfolds', () => {
  it('shows who, to whom and what was sent when a row is opened', async () => {
    const journal = {
      teamId: 'team-1',
      entries: [{
        id: 'journal-1', kind: 'message/sent', category: 'message', at: 1_700_000_000_000,
        actor: 'm-1', actorName: 'Reviewer', summary: 'Reviewer sent message to Lead',
        summaryParts: [{ text: 'Reviewer', strong: true }, { text: ' sent message to ' }, { text: 'Lead', strong: true }],
        refs: { messageId: 'msg-1', taskId: 'task-1' },
        fields: [{ label: 'Actor', value: 'Reviewer (m-1)' }, { label: 'To', value: 'Lead (m-2)' }],
        detail: '## Done\n\n- one\n- two',
      }],
    }
    const view = await renderView({ journal })
    // The one-line summary names a person, not an id.
    expect(view.textContent).toContain('Reviewer sent message to Lead')
    const strongNames = Array.from(view.querySelectorAll('.dshLiveTeamsJournalSummary strong')).map((node) => node.textContent)
    expect(strongNames).toEqual(['Reviewer', 'Lead'])
    const line = view.querySelector<HTMLButtonElement>('.dshLiveTeamsJournalLine')
    expect(line?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { line?.click() })
    const panel = view.querySelector('.dshLiveTeamsJournalDetailPanel')
    expect(panel?.textContent).toContain('Reviewer (m-1)')
    expect(panel?.textContent).toContain('Lead (m-2)')
    expect(panel?.textContent).toContain('journalBody')
    // The body is rendered, and the toggle shows it as it was written.
    const toggle = panel?.querySelector<HTMLButtonElement>('.dshLiveTeamsJournalRawToggle')
    expect(toggle?.textContent).toBe('journalRaw')
    await act(async () => { toggle?.click() })
    expect(view.querySelector('.dshLiveTeamsJournalRawMessage')?.textContent).toContain('## Done')
    // A row about a task shows the contract itself, fetched when the row is opened.
    const taskBlock = view.querySelector('.dshLiveTeamsJournalTaskLine')
    expect(taskBlock?.textContent).toContain('Build report')
    expect(view.querySelector('.dshLiveTeamsJournalRawTask')?.textContent).toContain('# Build report')
  })
})

describe('member interruption action', () => {
  it('renders the action only for running members and confirmation names unchanged state', async () => {
    const view = await renderView({ snapshot: { ...snapshot, members: [
      { ...snapshot.members[0], status: 'running' },
      { ...snapshot.members[0], memberId: 'm-idle', displayName: 'Idle', status: 'idle' },
    ] } })
    const collapsed = view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')
    expect(view.querySelectorAll('.dshLiveTeamsRow select')).toHaveLength(0)
    await act(async () => { collapsed?.click() })
    const actions = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsInterruptButton'))
    expect(actions).toHaveLength(1)
    expect(actions[0]?.getAttribute('aria-label')).toContain('Build')
    await act(async () => { actions[0]?.click() })
    const dialog = view.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('interruptTurnDescription')
    expect(dialog?.textContent).toContain('interruptTurnKeeps')
    expect(dialog?.textContent).toContain('interruptTurn')
  })

  it('surfaces a 409 as a notice rather than success', async () => {
    const view = await renderView({ interruptStatus: 409, snapshot: { ...snapshot, members: [{ ...snapshot.members[0], status: 'running' }] } })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const action = view.querySelector<HTMLButtonElement>('.dshLiveTeamsInterruptButton')
    await act(async () => { action?.click() })
    const confirm = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'interruptTurn')
    await act(async () => { confirm?.click() })
    // The refusal has to reach the persistent notice, not merely appear somewhere in the
    // tree: the human's complaint was that a press looked like it did nothing (F18).
    const notice = view.querySelector('.dshLiveTeamsNotice')
    expect(notice?.textContent).toContain('noRunningTurn')
    expect(view.textContent).not.toContain('turnInterrupted')
  })
})

describe('member removal action', () => {
  it('renders an accessible remove action for every member and confirmation says Session is not interrupted', async () => {
    const view = await renderView()
    const actionsBefore = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsMemberRemove'))
    expect(actionsBefore).toHaveLength(0)
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const actions = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsMemberRemove'))
    expect(actions).toHaveLength(snapshot.members.length)
    for (const entry of snapshot.members) expect(actions.find((button) => button.getAttribute('aria-label')?.includes(entry.displayName))).not.toBeUndefined()
    await act(async () => { actions[0]?.click() })
    const dialog = view.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('sessionContinues')
    expect(dialog?.textContent).not.toMatch(/stop|terminate|close/i)
  })
})

describe('B18 contact policy UI', () => {
  const contactSnapshot = {
    teamId: 'team-1',
    teamName: 'B1 Check',
    workspacePath: '/w',
    revision: 3,
    members: [
      { memberId: 'm-lead', displayName: 'Lead', role: 'lead', availability: 'available', sessionId: 'lead-session', live: true, status: 'running' as const, bindingGeneration: 0, contractRevision: 0, permittedContacts: ['m-lead', 'human'] },
      { memberId: 'm-worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 'worker-session', live: true, status: 'idle' as const, bindingGeneration: 0, contractRevision: 0, permittedContacts: ['m-lead', 'm-peer'] },
      { memberId: 'm-peer', displayName: 'Peer', role: 'reviewer', availability: 'available', sessionId: 'peer-session', live: true, status: 'idle' as const, bindingGeneration: 0, contractRevision: 0, permittedContacts: ['m-lead'] },
    ],
  }

  it('shows each member permitted contacts and the grant control on the lead row', async () => {
    const view = await renderView({ snapshot: contactSnapshot })
    const openPanel = async (name: string): Promise<HTMLElement | null> => {
      const rows = Array.from(view.querySelectorAll<HTMLElement>('.dshLiveTeamsRow'))
      const row = rows.find((entry) => entry.querySelector('.dshLiveTeamsMemberName')?.textContent === name)
      await act(async () => { row?.querySelector<HTMLElement>('.dshLiveTeamsMemberCollapsed')?.click() })
      return view.querySelector<HTMLElement>('.dshLiveTeamsMemberPanel')
    }
    const lead = await openPanel('Lead')
    expect(lead?.querySelector('.dshLiveTeamsGrantControls')).not.toBeNull()
    expect(Array.from(lead?.querySelectorAll('.dshLiveTeamsContactChip') ?? []).map(chip => chip.textContent)).toEqual(['Lead', 'memberContactHuman'])
    // The chooser is a styled field, not a bare select with browser chrome.
    expect(lead?.querySelector('.dshLiveTeamsContactSelect')?.className).toContain('dshLiveTeamsRoleInput')
    const worker = await openPanel('Worker')
    expect(Array.from(worker?.querySelectorAll('.dshLiveTeamsContactChip') ?? []).map(chip => chip.textContent)).toEqual(['Lead', 'Peer'])
    expect(worker?.querySelector('.dshLiveTeamsGrantControls')).toBeNull()
    const peer = await openPanel('Peer')
    expect(peer?.querySelector('.dshLiveTeamsGrantControls')).toBeNull()
  })

  it('calls the grant route with the selected contact and action', async () => {
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = []
    const view = await renderView({ snapshot: contactSnapshot, fetchCalls })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsMemberCollapsed')?.click() })
    const controls = view.querySelector<HTMLElement>('.dshLiveTeamsGrantControls')
    const select = controls?.querySelector('select')
    const grant = Array.from(controls?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === 'grant')
    expect(select).not.toBeNull()
    expect(grant).not.toBeUndefined()
    await act(async () => {
      if (select === null || select === undefined || grant === undefined) return
      select.value = 'm-worker'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
    await act(async () => { grant?.click(); await new Promise((resolve) => setTimeout(resolve, 1)) })
    const request = fetchCalls.find((entry) => entry.url === '/api/live-teams/member/grant' && entry.method === 'POST')
    expect(request).not.toBeUndefined()
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({ memberId: 'm-lead', allow: 'm-worker', action: 'add' })
  })

  it('surfaces the server refusal text when a member send is rejected', async () => {
    const view = await renderView({ snapshot: contactSnapshot, messageSendStatus: 400, messageSendError: 'server says: send this to your lead' })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsInboxButton')?.click() })
    const selects = view.querySelectorAll<HTMLSelectElement>('.dshLiveTeamsComposer select')
    const textarea = view.querySelector<HTMLTextAreaElement>('.dshLiveTeamsComposer textarea')
    const send = Array.from(view.querySelectorAll<HTMLButtonElement>('.dshLiveTeamsComposer button')).find((button) => button.textContent === 'sendMessage')
    expect(selects).toHaveLength(2)
    expect(textarea).not.toBeNull()
    expect(send).not.toBeUndefined()
    await act(async () => {
      if (selects[0] === undefined) return
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(selects[0], 'm-peer')
      selects[0].dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      if (selects[1] === undefined) return
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(selects[1], 'comment')
      selects[1].dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      if (textarea === null) return
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { send?.click(); await new Promise((resolve) => setTimeout(resolve, 2)) })
    expect(view.textContent).toContain('server says: send this to your lead')
    expect(view.textContent).not.toContain('messageSendFailed')
  })
})

describe('B17 lead and briefing UI', () => {
  it('renders the Lead control, Briefing card text, and member note on its row', async () => {
    const view = await renderView()
    await openSettings(view)
    expect(view.querySelector('.dshLiveTeamsLeadControl')).not.toBeNull()
    expect(view.textContent).toContain('Order text')
    expect(view.textContent).toContain('implements')
    expect(view.textContent).toContain('briefing')
  })

  it('disables opening the briefing when host capability is unavailable', async () => {
    const view = await renderView({ team: { enabled: true, teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', revision: 3, memberCount: 1, briefing: 'Order text', openAvailable: false } })
    await openSettings(view)
    const button = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent === 'openBriefing')
    expect(button).not.toBeUndefined()
    expect(button?.disabled).toBe(true)
  })
})

describe('team mode', () => {
  it('offers to enable the team when it is switched off for this workspace', async () => {
    const view = await renderView({ team: { enabled: false, teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', memberCount: 0 } })
    expect(view.textContent).toContain('teamOffTitle')
    expect(view.textContent).toContain('enableTeam')
    // Nothing from the member view is rendered while the team is off.
    expect(view.querySelector('.dshLiveTeamsRows')).toBeNull()
    expect(view.querySelector('.dshLiveTeamsRoleRow')).toBeNull()
  })

  it('shows the team name and the disable action when the team is on', async () => {
    const view = await renderView()
    await openSettings(view)
    expect(view.textContent).toContain('B1 Check')
    expect(view.textContent).toContain('disableTeam')
    // The rename control is an icon button, so its name carries the meaning.
    expect(Array.from(view.querySelectorAll('button')).some((button) => (button.getAttribute('aria-label') ?? '').includes('renameTeam'))).toBe(true)
  })
})

describe('role panel', () => {
  it('renders one row per registry role and keeps every row', async () => {
    const view = await renderView()
    await openSettings(view)
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsRoles .dshLiveTeamsCollapseHeader')?.click() })
    const rows = Array.from(view.querySelectorAll('.dshLiveTeamsRoleRow'))
    expect(rows).toHaveLength(roles.roles.length)
    for (const role of roles.roles) {
      expect(view.textContent).toContain(role.name)
    }
  })

  it('offers customization for a global role and opening for a customized one', async () => {
    const view = await renderView()
    await openSettings(view)
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsRoles .dshLiveTeamsCollapseHeader')?.click() })
    const rows = Array.from(view.querySelectorAll<HTMLElement>('.dshLiveTeamsRoleRow'))
    const customized = rows.find((row) => row.textContent?.includes('Builder'))
    const global = rows.find((row) => row.textContent?.includes('Oracle'))
    // The view is rendered without a locale, so `t` returns dictionary keys.
    expect(customized?.textContent).toContain('roleCustomized')
    expect(global?.textContent).toContain('roleGlobal')
    // The customized role exposes its file, never a second copy action.
    expect(customized?.querySelectorAll('button')).toHaveLength(1)
    expect(customized?.querySelector('button')?.textContent).toContain('openRoleFile')
    expect(customized?.querySelector('button')?.textContent).not.toContain('customizeRole')
    // The global role exposes customization, never a file it does not own.
    expect(global?.querySelectorAll('button')).toHaveLength(1)
    expect(global?.querySelector('button')?.textContent).toContain('customizeRole')
  })

  it('names every action after its role, so the buttons are distinguishable', async () => {
    const view = await renderView()
    await openSettings(view)
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsRoles .dshLiveTeamsCollapseHeader')?.click() })
    const labels = Array.from(view.querySelectorAll<HTMLElement>('.dshLiveTeamsRoleRow button')).map((button) => button.getAttribute('aria-label') ?? '')
    expect(labels).toHaveLength(2)
    expect(labels[0]).toContain('Builder')
    expect(labels[1]).toContain('Oracle')
  })

  it('renders the role panel inside the compact Team controls card', async () => {
    const view = await renderView()
    await openSettings(view)
    const controls = view.querySelector('.dshLiveTeamsTeamControls')
    const panel = controls?.querySelector('.dshLiveTeamsRoles')
    expect(controls).not.toBeNull()
    expect(panel).not.toBeNull()
  })

  it('renders no open action when the host cannot open paths', async () => {
    const view = await renderView({ roles: { ...roles, openAvailable: false, globalOpenAvailable: false } })
    await openSettings(view)
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsRoles .dshLiveTeamsCollapseHeader')?.click() })
    const rows = Array.from(view.querySelectorAll<HTMLElement>('.dshLiveTeamsRoleRow'))
    expect(rows).toHaveLength(2)
    // Rows stay visible; only the action that cannot work is withheld.
    expect(view.querySelectorAll('.dshLiveTeamsRoleRow button')).toHaveLength(1)
  })
})

describe('human messages composer and inbox', () => {
  const inboxWith = (state: 'stored' | 'acknowledged') => ({
    teamId: 'team-1',
    messages: [
      { id: 'msg-1', from: 'z-live', fromName: 'Zed', kind: 'comment', content: 'the review is ready', createdAt: 10, delivery: { id: 'd-1', state } },
    ],
  })

  it('labels all three kinds with what they do', async () => {
    const view = await renderView({ messages: { teamId: 'team-1', messages: [] } })
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsInboxButton')?.click() })
    const kindSelect = view.querySelectorAll('.dshLiveTeamsComposer select')[1]
    const optionNodes = kindSelect === null || kindSelect === undefined ? [] : Array.from(kindSelect.querySelectorAll('option'))
    const options = optionNodes.map((option) => option.textContent ?? '')
    // This environment resolves translations to their keys, so the assertion is
    // that every kind carries its own consequence hint — never a bare label.
    for (const hint of ['messageKindMessageHint', 'messageKindDirectionHint', 'messageKindCommentHint']) {
      expect(options.some((text) => text.includes(hint))).toBe(true)
    }
    // And the dictionaries really do say what each kind does, in both locales.
    const { dictionaries } = await import('./locales.js')
    expect(dictionaries.en.messageKindMessageHint).toContain('turn')
    expect(dictionaries.en.messageKindDirectionHint).toContain('steer')
    expect(dictionaries.en.messageKindCommentHint).toContain('wakes nobody')
    expect(dictionaries.ru.messageKindCommentHint.length).toBeGreaterThan(0)
  })

  /**
   * The inbox stopped being a surface to read: the conversation with a member
   * happens in that member's Session, and the header chip says when someone is
   * waiting. What is left here is the archive, so it stays folded until asked
   * for — which is also what keeps a 40 KB backlog off the tab.
   */
  const expandInbox = async (view: HTMLElement): Promise<void> => {
    await act(async () => { view.querySelector<HTMLButtonElement>('.dshLiveTeamsInboxButton')?.click() })
  }

  it('keeps the whole inbox folded, with the unread count in the header', async () => {
    // The folded count comes from the cheap attention projection, so the archive
    // is never read just to render a number.
    const view = await renderView({ messages: inboxWith('stored'), attention: { teamId: 'team-1', attention: [{ memberId: 'z-live', name: 'Zed', sessionId: 's-live', waiting: 1, since: 1, kind: 'comment' }] } })
    // The count arrives from its own request, so one more turn of the loop.
    await act(async () => { await Promise.resolve() })
    expect(view.querySelector('.dshLiveTeamsInbox')).toBeNull()
    const toggle = view.querySelector<HTMLButtonElement>('.dshLiveTeamsInboxButton')
    // The count sits on the control that opens the inbox, and nothing else of it is rendered.
    expect(toggle?.textContent).toContain('1')
    expect(toggle?.querySelector('.dshLiveTeamsInboxCount')?.textContent).toBe('1')
  })

  it('renders inbox rows with sender, kind and content once asked', async () => {
    const content = 'Проверка завершена: PASS.\n\n- `make check` — exit 0.\n- Два  пробела сохранены.\n\nПолные результаты — в вердикте.'
    const inbox = inboxWith('stored')
    inbox.messages[0]!.content = content
    const view = await renderView({ messages: inbox })
    await expandInbox(view)
    const row = view.querySelector('.dshLiveTeamsInboxRow')
    expect(row?.textContent).toContain('Zed')
    expect(row?.textContent).toContain('Comment')
    expect(row?.querySelector('p')?.textContent).toBe(content)
    const { css } = await import('./styles.js')
    expect(css.match(/\.dshLiveTeamsInboxRow p\s*\{([^}]+)\}/)?.[1]).toContain('white-space: pre-wrap')
  })

  it('offers acknowledgement only while a row is unacknowledged', async () => {
    const stored = await renderView({ messages: inboxWith('stored') })
    await expandInbox(stored)
    expect(stored.querySelector('.dshLiveTeamsInboxRow button')?.textContent).toContain('acknowledge')

    const acknowledged = await renderView({ messages: inboxWith('acknowledged') })
    await expandInbox(acknowledged)
    // An acknowledged row carries no action at all, and says so.
    expect(acknowledged.querySelector('.dshLiveTeamsInboxRow button')).toBeNull()
    expect(acknowledged.querySelector('.dshLiveTeamsInboxAcknowledged')?.textContent).toContain('acknowledged')
  })

  it('says the inbox is empty instead of rendering a bare box', async () => {
    const view = await renderView({ messages: { teamId: 'team-1', messages: [] } })
    await expandInbox(view)
    expect(view.querySelector('.dshLiveTeamsInboxList')).toBeNull()
    expect(view.querySelector('.dshLiveTeamsInbox')?.textContent ?? '').not.toBe('')
  })
})

describe('the lead survives a members refresh', () => {
  const leadSnapshot = {
    teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', revision: 3,
    members: [
      { memberId: 'm-lead', displayName: 'Lead', role: 'lead', availability: 'available', sessionId: 'lead-session', live: true, status: 'idle' as const, bindingGeneration: 0, contractRevision: 0, permittedContacts: ['m-lead'] },
      { memberId: 'm-worker', displayName: 'Worker', role: 'builder', availability: 'available', sessionId: 'worker-session', live: false, status: 'unknown' as const, bindingGeneration: 0, contractRevision: 0, permittedContacts: ['m-lead'] },
    ],
  }

  it('keeps the resolved lead after the snapshot is re-read', async () => {
    const view = await renderView({ snapshot: leadSnapshot, team: { enabled: true, teamId: 'team-1', teamName: 'B1 Check', workspacePath: '/w', revision: 3, memberCount: 2 } })
    await openSettings(view)
    const select = (): HTMLSelectElement | null => view.querySelector<HTMLSelectElement>('.dshLiveTeamsLeadControl select')
    // The members snapshot carries no lead on the real server; the tab must take it
    // from the resolving route and must not clear it when members are refreshed.
    // Clearing it is what showed "Not set" in the live tab while every member's own
    // context said "Lead: Lead".
    expect(select()?.value).toBe('m-lead')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    expect(select()?.value).toBe('m-lead')
  })
})
