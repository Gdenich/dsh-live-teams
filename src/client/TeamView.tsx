import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  MarkdownText,
  IconEditOutline16,
  IconPlusOutline16,
  Modal,
  IconPauseOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
  IconChevronDownOutline14,
  StateDot,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DispatchTaskVerdict, MessageKind, TaskStatus, TaskSummary, TeamAdoptionCandidate, TeamAttemptStatus, TeamCandidate, TeamDispatch, TeamInboxMessage, TeamMember, TeamSnapshot, TeamRoles, TeamSubmissionScope, TeamTaskDetail } from './api.js'
import type { LocaleKey } from './locales.js'
import { memberNameFromTitle } from './member-name.js'
import { acceptTeamTask, acknowledgeTeamMessage, adoptTeam, addTeamMember, createTeamTask, revokeTeamTask, updateTeamTask, canOpenWorkspaceRoles, changeMemberAvailability, changeMemberDisplayName, changeMemberRole, createTeamSessionMember, disableTeam, enableTeam, fetchTeamAdoptionCandidates, fetchTeamAttention, fetchTeamCandidates, fetchTeamInbox, fetchTeamLead, fetchTeamRoles, fetchTeamSnapshot, fetchTeamState, fetchTeamTask, fetchTeamTasks, grantTeamContact, interruptTeamMember, LiveTeamsApiError, openTeamBriefing, openTeamRoles, overrideTeamRole, removeTeamMember, renameTeam, reviseTeamTask, sendTeamMessage, setTeamLead, fetchTeamDispatch, setTeamDispatch, type TeamStateStatus } from './api.js'
import './styles.js'

export type TeamViewContext = {
  readonly sessions: { open(sessionId: string): void }
  readonly t: (key: LocaleKey) => string
}

export type TeamViewProps = {
  readonly ctx?: TeamViewContext
  /** Session the view belongs to; the host serves this Session's workspace team. */
  readonly sessionId?: string
  /** How often the tab re-reads tasks while visible. Exposed so the test can watch it. */
  readonly pollMs?: number
}

function fallback(key: LocaleKey): string { return key }

/**
 * The server names the reason it refused a member; showing "Unable to add team
 * member" instead throws that away and leaves the human guessing. Unknown text
 * is passed through rather than replaced by a vaguer sentence.
 */
const addMemberFailureKeys: Record<string, LocaleKey> = {
  'live-teams session not found': 'addMemberSessionMissing',
  'live-teams session not in workspace': 'addMemberSessionElsewhere',
  'live-teams invalid request': 'addMemberAlreadyMember',
  'live-teams unknown role': 'addMemberUnknownRole',
  'live-teams state unavailable': 'stateUnavailable',
  'live-teams workspace not registered': 'workspaceNotRegistered',
}

function addMemberFailure(cause: unknown, t: (key: LocaleKey) => string): string {
  if (!(cause instanceof LiveTeamsApiError)) return t('addMemberFailed')
  const server = cause.error
  if (server === undefined || server.length === 0) return t('addMemberFailed')
  const key = addMemberFailureKeys[server]
  return key === undefined ? server : t(key)
}
function bindingLabel(member: TeamMember, t: (key: LocaleKey) => string): string { return member.sessionId === null ? t('unbound') : t('bound') }
function statusLabel(member: TeamMember, t: (key: LocaleKey) => string): string {
  if (member.status === 'idle') return t('idle')
  if (member.status === 'running') return t('running')
  return t('unknown')
}

function stateDot(member: TeamMember): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  if (!member.live) return 'warning'
  if (member.status === 'running') return 'ongoing'
  if (member.status === 'idle') return 'done'
  return 'idle'
}

function stateText(member: TeamMember, t: (key: LocaleKey) => string): string {
  return `${member.live ? t('live') : t('notLive')} · ${statusLabel(member, t)}`
}

export type TaskFilter = 'active' | 'waiting' | 'archived'
type TaskDetails = Record<string, TeamTaskDetail>
type JournalCategory = 'message' | 'delivery' | 'task' | 'review' | 'contact' | 'team' | 'member' | 'other'
type JournalEntry = {
  readonly id: string
  readonly kind: string
  readonly category: JournalCategory
  readonly at: number
  readonly actor?: string
  readonly actorName?: string
  readonly summary: string
  readonly refs: { readonly taskId?: string; readonly taskTitle?: string; readonly messageId?: string; readonly round?: number }
  readonly fields?: readonly { readonly label: string; readonly value: string }[]
  readonly summaryParts?: readonly { readonly text: string; readonly strong?: boolean }[]
  readonly detail?: string
}
type JournalResponse = { readonly teamId: string; readonly entries: JournalEntry[]; readonly nextOffset?: number; readonly truncated?: boolean }

const journalCategories: readonly JournalCategory[] = ['message', 'delivery', 'task', 'review', 'contact', 'team', 'member', 'other']
const journalCategoryKeys: Record<JournalCategory, LocaleKey> = {
  message: 'journalFilterMessage',
  delivery: 'journalFilterDelivery',
  task: 'journalFilterTask',
  review: 'journalFilterReview',
  contact: 'journalFilterContact',
  team: 'journalFilterTeam',
  member: 'journalFilterMember',
  other: 'journalFilterOther',
}

function isJournalCategory(value: unknown): value is JournalCategory {
  return typeof value === 'string' && (journalCategories as readonly string[]).includes(value)
}

/**
 * The journal, from a byte cursor when we have one.
 *
 * The file grows forever and the panel re-reads it every few seconds; asking for everything was the
 * only part of polling that got worse with age. The server returns `nextOffset`, we hand it back, and
 * pay only for what is new.
 */
async function fetchJournal(session?: string, after?: number): Promise<JournalResponse> {
  const query = new URLSearchParams({ limit: '100' })
  if (after !== undefined) query.set('after', String(after))
  if (session !== undefined && session.length > 0) query.set('session', session)
  const response = await fetch(`/api/live-teams/journal?${query.toString()}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } })
  let body: unknown
  try { body = await response.json() as unknown } catch { throw new LiveTeamsApiError(response.status, 'invalid team response') }
  if (!response.ok) {
    const error = body !== null && typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>).error === 'string' ? (body as Record<string, unknown>).error as string : 'team request failed'
    throw new LiveTeamsApiError(response.status, error)
  }
  const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  if (typeof record.teamId !== 'string' || !Array.isArray(record.entries)) throw new LiveTeamsApiError(500, 'invalid team response')
  const nextOffset = typeof record.nextOffset === 'number' && Number.isInteger(record.nextOffset) && record.nextOffset >= 0 ? record.nextOffset : undefined
  const truncated = record.truncated === true
  const entries = record.entries.flatMap((raw): JournalEntry[] => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== 'string' || typeof entry.kind !== 'string' || !isJournalCategory(entry.category) || typeof entry.at !== 'number' || typeof entry.summary !== 'string') return []
    const refsValue = entry.refs
    const refs = refsValue !== null && typeof refsValue === 'object' && !Array.isArray(refsValue) ? refsValue as JournalEntry['refs'] : {}
    const fields = Array.isArray(entry.fields)
      ? entry.fields.flatMap((raw): { label: string; value: string }[] => {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
          const field = raw as Record<string, unknown>
          return typeof field.label === 'string' && typeof field.value === 'string' ? [{ label: field.label, value: field.value }] : []
        })
      : undefined
    const summaryParts = Array.isArray(entry.summaryParts)
      ? entry.summaryParts.flatMap((raw): { text: string; strong?: boolean }[] => {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
          const part = raw as Record<string, unknown>
          return typeof part.text === 'string' ? [{ text: part.text, ...(part.strong === true ? { strong: true } : {}) }] : []
        })
      : undefined
    return [{ id: entry.id, kind: entry.kind, category: entry.category, at: entry.at, ...(summaryParts === undefined || summaryParts.length === 0 ? {} : { summaryParts }), ...(typeof entry.actor === 'string' ? { actor: entry.actor } : {}), ...(typeof entry.actorName === 'string' ? { actorName: entry.actorName } : {}), summary: entry.summary, refs, ...(fields === undefined || fields.length === 0 ? {} : { fields }), ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}) }]
  })
  return { teamId: record.teamId, entries, ...(nextOffset === undefined ? {} : { nextOffset }), ...(truncated ? { truncated: true } : {}) }
}

function routeWords(route: TaskSummary['route']): string {
  if (route === undefined) return '—'
  if (route.type === 'report') return `report → ${route.to === 'human' ? 'human' : route.toName ?? route.to}`
  if (route.type === 'review') return `review → ${route.reviewerName ?? route.reviewer}`
  if (route.type === 'custom') return `custom → ${route.description}`
  return `interactive → ${routeWords(route.then)}`
}

function taskAge(updatedAt: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - updatedAt)
  const minutes = Math.floor(elapsed / 60000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export const attemptStatusKeys: Record<TeamAttemptStatus, LocaleKey> = {
  active: 'attemptStatusactive',
  revoking: 'attemptStatusrevoking',
  revoked: 'attemptStatusrevoked',
  completed: 'attemptStatuscompleted',
  failed: 'attemptStatusfailed',
}

export const scopeKeys: Record<TeamSubmissionScope['state'], LocaleKey> = {
  clean: 'scopeClean',
  violation: 'scopeViolation',
  'shared-tree': 'scopeSharedTree',
  unchecked: 'scopeUnchecked',
}

export const scopeReasonKeys: Record<NonNullable<TeamSubmissionScope['reason']>, LocaleKey> = {
  'no-repository': 'scopeReasonNoRepository',
  'too-many-files': 'scopeReasonTooManyFiles',
  'no-snapshot': 'scopeReasonNoSnapshot',
  unreadable: 'scopeReasonUnreadable',
}

/** The tooltip says what was observed, not what it might mean. */
function scopeTitle(scope: TeamSubmissionScope, t: (key: LocaleKey) => string): string {
  const parts = [t(scopeKeys[scope.state])]
  const unexpected = scope.unexpected ?? []
  const sharedTree = scope.sharedTree ?? []
  const declared = scope.declared ?? []
  if (unexpected.length > 0) parts.push(`${t('scopeUnexpected')}: ${unexpected.join(', ')}`)
  if (sharedTree.length > 0) parts.push(`${t('scopeSharedTreeNote')}: ${sharedTree.join(', ')}`)
  if (declared.length > 0) parts.push(`${t('scopeDeclared')}: ${declared.join(', ')}`)
  // B32: which evidence this is, and — when it could not look — why. "Unchecked" alone
  // leaves the reader to guess whether nothing happened or nobody looked.
  if (scope.mode !== undefined) parts.push(t(scope.mode === 'git' ? 'scopeModeGit' : 'scopeModeFiles'))
  if (scope.state === 'unchecked' && scope.reason !== undefined) parts.push(t(scopeReasonKeys[scope.reason]))
  return parts.join(' · ')
}

export const taskStatusKeys: Record<TaskStatus, LocaleKey> = {
  draft: 'taskStatusdraft',
  ready: 'taskStatusready',
  claimed: 'taskStatusclaimed',
  in_progress: 'taskStatusin_progress',
  waiting: 'taskStatuswaiting',
  needs_human: 'taskStatusneeds_human',
  completed: 'taskStatuscompleted',
  failed: 'taskStatusfailed',
  cancelled: 'taskStatuscancelled',
}

export const taskFilterKeys: Record<TaskFilter, LocaleKey> = {
  active: 'tasksFilteractive',
  waiting: 'tasksFilterwaiting',
  archived: 'tasksFilterarchived',
}

export const messageKindKeys: Record<MessageKind, LocaleKey> = {
  message: 'messageKindMessage',
  direction: 'messageKindDirection',
  comment: 'messageKindComment',
}

/**
 * The one-word reason a task is not running, for the row chip. `dependency-open`
 * is already the `Blocked` chip and the task's own status carries `waiting` and
 * `needs_human`, so those stay silent rather than saying the same thing twice.
 */
const DISPATCH_CHIP_KEYS: Record<string, LocaleKey> = {
  'member-paused': 'taskQueuedMemberPaused',
  'member-busy': 'taskQueuedMemberBusy',
  'no-session': 'taskQueuedNoSession',
  'attempt-revoking': 'taskQueuedRevoking',
  'member-unknown': 'taskQueuedDeparted',
  'coding-not-isolated': 'taskQueuedCoding',
  'paths-undeclared': 'taskQueuedNoPaths',
  'paths-overlap': 'taskQueuedPathsOverlap',
  'paths-shared': 'taskQueuedPathsShared',
  'human-intervened': 'taskQueuedIntervened',
}

function taskStatusLabel(status: TaskSummary['status'], t: (key: LocaleKey) => string): string {
  return t(taskStatusKeys[status])
}

/** Name each blocker with its status: "blocked" alone does not say what to fix. */
function blockerWords(blockers: readonly { title: string; status: TaskStatus }[], t: (key: LocaleKey) => string): string {
  return blockers.map((blocker) => `${blocker.title} — ${taskStatusLabel(blocker.status, t)}`).join('; ')
}

function taskMatchesFilter(task: TaskSummary, filter: TaskFilter): boolean {
  const archived = task.archivedPath !== undefined
  if (filter === 'archived') return archived
  if (archived) return false
  if (filter === 'waiting') return task.status === 'waiting' || task.status === 'needs_human'
  // `Active` means "work that is still live": a finished task used to stay here forever
  // because the filter only excluded the waiting pair, and the human watched three
  // completed tasks sit under Active (second live run, F15).
  return task.status !== 'waiting' && task.status !== 'needs_human' && task.status !== 'completed'
}

function isActiveTask(task: TaskSummary): boolean {
  return task.archivedPath === undefined && (task.status === 'ready' || task.status === 'claimed' || task.status === 'in_progress')
}

function awaitsLead(task: TaskSummary): boolean {
  return task.archivedPath === undefined && (task.status === 'waiting' || task.status === 'needs_human')
}

function artifactLabel(artifact: TeamTaskDetail['submissions'][number]['artifact']): string {
  return artifact.type === 'report' ? `${artifact.bodyRef} · ${artifact.bodyDigest}` : `${artifact.paths.join(', ')} · ${artifact.manifestDigest}`
}

export function TeamView(props: TeamViewProps): React.ReactElement {
  const t = props.ctx?.t ?? fallback
  const session = props.sessionId
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LiveTeamsApiError | null>(null)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [roleBusy, setRoleBusy] = useState<Set<string>>(() => new Set())
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({})
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({})
  const [editingName, setEditingName] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const nameEditButtons = useRef<Record<string, HTMLButtonElement | null>>({})
  const focusAfterNameEdit = useRef<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [candidates, setCandidates] = useState<TeamCandidate[]>([])
  /** Team name carried by the candidates response — the suffix its titles end with. */
  const [candidateTeamName, setCandidateTeamName] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [interruptTarget, setInterruptTarget] = useState<TeamMember | null>(null)
  const [interruptBusy, setInterruptBusy] = useState(false)
  const [addName, setAddName] = useState('')
  const [addRole, setAddRole] = useState('')
  const [roleData, setRoleData] = useState<TeamRoles | null>(null)
  const [roleLoading, setRoleLoading] = useState(true)
  const [teamState, setTeamState] = useState<TeamStateStatus | null>(null)
  const [briefingText, setBriefingText] = useState('')
  const [teamLoading, setTeamLoading] = useState(true)
  const [teamBusy, setTeamBusy] = useState(false)
  const [leadMemberId, setLeadMemberId] = useState<string | undefined>(undefined)
  const [inbox, setInbox] = useState<TeamInboxMessage[]>([])
  const [inboxLoading, setInboxLoading] = useState(true)
  /** Unread count for the folded header, read from the same projection as the header chip. */
  const [attentionWaiting, setAttentionWaiting] = useState(0)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [journalLoading, setJournalLoading] = useState(true)
  const [journalFilters, setJournalFilters] = useState<Set<JournalCategory>>(() => new Set(journalCategories))
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(() => new Set())
  const [briefingExpanded, setBriefingExpanded] = useState(false)
  const [rolesExpanded, setRolesExpanded] = useState(false)
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('active')
  const [taskSummaries, setTaskSummaries] = useState<TaskSummary[]>([])
  const [dispatch, setDispatch] = useState<TeamDispatch | null>(null)
  const [dispatchBusy, setDispatchBusy] = useState(false)
  const [taskDetails, setTaskDetails] = useState<TaskDetails>({})
  const [taskExpanded, setTaskExpanded] = useState<string | null>(null)
  const [taskLoading, setTaskLoading] = useState(true)
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [taskNotice, setTaskNotice] = useState<string | null>(null)
  const [taskNote, setTaskNote] = useState('')
  const [taskInstructions, setTaskInstructions] = useState('')
  const [taskConfirm, setTaskConfirm] = useState<{ kind: 'accept' | 'revise'; task: TaskSummary } | null>(null)
  // The human's own control over work: a draft for a new task or an edited contract, and a reason
  // for releasing a held attempt.
  /** Where the journal read left off. A ref: changing it must not re-create the poll callback. */
  const journalOffset = useRef<number | undefined>(undefined)
  /** Is anything actually happening? The poll interval reads this without re-creating the timer. */
  const busyRef = useRef(false)
  /** Which journal row is unfolded, and whether its body is shown as raw text instead of markdown. */
  const [journalExpanded, setJournalExpanded] = useState<string | null>(null)
  const [journalRaw, setJournalRaw] = useState(false)
  /** The contract of a task a journal row is about, fetched when that row is opened. */
  const [journalTask, setJournalTask] = useState<Record<string, TeamTaskDetail | undefined>>({})
  const [taskDraft, setTaskDraft] = useState<{ editing?: string } | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftKind, setDraftKind] = useState('implementation')
  const [draftAssignee, setDraftAssignee] = useState('')
  const [draftRoute, setDraftRoute] = useState<'report' | 'review'>('report')
  const [draftReviewer, setDraftReviewer] = useState('')
  const [draftPaths, setDraftPaths] = useState('')
  const [draftAcceptance, setDraftAcceptance] = useState('')
  const [draftChecks, setDraftChecks] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftBusy, setDraftBusy] = useState(false)
  const [releaseTarget, setReleaseTarget] = useState<TaskSummary | null>(null)
  const [releaseReason, setReleaseReason] = useState('')
  const [messageTo, setMessageTo] = useState('')
  const [messageKind, setMessageKind] = useState<MessageKind | ''>('')
  const [messageContent, setMessageContent] = useState('')
  /**
   * The inbox is collapsed by default and no longer a surface to read: the
   * conversation with a member happens in that member's Session, and the header
   * chip says when someone is waiting. What stays here is the archive and the
   * acknowledgement trail.
   */
  const [inboxExpanded, setInboxExpanded] = useState(false)
  const [messageBusy, setMessageBusy] = useState(false)
  const [grantTarget, setGrantTarget] = useState('')
  const [grantBusy, setGrantBusy] = useState<string | null>(null)
  const [adoptionCandidates, setAdoptionCandidates] = useState<TeamAdoptionCandidate[]>([])
  const [adoptionLoading, setAdoptionLoading] = useState(false)
  const [teamNameDraft, setTeamNameDraft] = useState('')
  const [editingTeamName, setEditingTeamName] = useState(false)
  const [disableConfirm, setDisableConfirm] = useState(false)
  const refreshRoles = useCallback((options: { silent?: boolean } = {}) => {
    if (options.silent !== true) setRoleLoading(true)
    void fetchTeamRoles(session).then((next) => {
      setRoleData((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }).catch(() => {}).finally(() => { if (options.silent !== true) setRoleLoading(false) })
  }, [session])

  const refreshInbox = useCallback(() => {
    setInboxLoading(true)
    void fetchTeamInbox(session).then((next) => setInbox(next.messages)).catch(() => setInbox([])).finally(() => setInboxLoading(false))
  }, [session])

  /**
   * One signature per read: a poll that returns the same content must not replace state,
   * or the card re-renders (and the list jumps) every few seconds for nothing.
   */

  const refreshJournal = useCallback((options: { silent?: boolean } = {}) => {
    const silent = options.silent === true
    // A silent poll must not flip the card into its loading state: doing that on every
    // tick made the journal blink every four seconds (found by the human on the stand).
    if (!silent) setJournalLoading(true)
    void fetchJournal(session, journalOffset.current).then((next) => {
      if (next.nextOffset !== undefined) journalOffset.current = next.nextOffset
      setJournal((current) => {
        // The first read is the tail of the file, so it replaces what we have; later reads are deltas.
        const base = next.truncated === true ? [] : current
        const seen = new Set(base.map((entry) => entry.id))
        const added = next.entries.filter((entry) => !seen.has(entry.id))
        if (added.length === 0) return base
        const merged = [...base, ...added].sort((left, right) => right.at - left.at)
        // The panel shows recent history; the file keeps all of it.
        return merged.slice(0, 500)
      })
    }).catch(() => { if (!silent) setJournal([]) }).finally(() => { if (!silent) setJournalLoading(false) })
  }, [session])

  const refreshTasks = useCallback((includeArchived = taskFilter === 'archived', options: { silent?: boolean } = {}) => {
    const silent = options.silent === true
    // A background poll must not flash the loading state, and a failed poll must keep the
    // last good list: an empty panel would read as "the team has no tasks".
    if (!silent) setTaskLoading(true)
    // The projection explains why a task is not running; a failure to read it must
    // not hide the tasks themselves.
    void fetchTeamDispatch(session).then((next) => {
      setDispatch((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }).catch(() => { if (!silent) setDispatch(null) })
    void fetchTeamTasks(session, includeArchived).then((next) => {
      const signature = (tasks: readonly TaskSummary[]): string => tasks.map((task) => `${task.id}:${task.status}:${task.updatedAt}`).join('|')
      setTaskSummaries((current) => signature(current) === signature(next.tasks) ? current : next.tasks)
    }).catch((cause: unknown) => {
      if (silent) return
      setTaskSummaries([])
      setTaskNotice(cause instanceof LiveTeamsApiError ? cause.error : t('tasksLoadFailed'))
    }).finally(() => { if (!silent) setTaskLoading(false) })
  }, [session, t, taskFilter])

  // A task in flight, or an attempt the projection calls active, is what "busy" means here.
  useEffect(() => {
    const tasksBusy = taskSummaries.some((task) => task.status === 'in_progress' || task.status === 'claimed')
    const attemptsBusy = dispatch?.tasks.some((entry) => entry.decision === 'active') === true
    busyRef.current = tasksBusy || attemptsBusy
  }, [taskSummaries, dispatch])

  const toggleDispatch = useCallback(() => {
    const next = dispatch?.paused === true ? 'auto' : 'paused'
    setDispatchBusy(true)
    setTaskNotice(null)
    void setTeamDispatch(next, undefined, session).then(() => refreshTasks()).catch((cause: unknown) => {
      setTaskNotice(cause instanceof LiveTeamsApiError ? cause.error : t('dispatchActionFailed'))
    }).finally(() => setDispatchBusy(false))
  }, [dispatch, refreshTasks, session, t])

  /** Member-facing signature: identity, role, name, availability, binding. */
  const memberSignature = (value: TeamSnapshot | null): string => value === null ? '' : value.members
    .map((member) => [member.memberId, member.role, member.displayName, member.availability, member.sessionId ?? '', member.live === true ? 'live' : 'idle'].join(':'))
    .join('|')

  const refresh = useCallback((options: { silent?: boolean } = {}) => {
    const silent = options.silent === true
    refreshRoles({ ...(silent ? { silent: true } : {}) })
    refreshJournal({ ...(silent ? { silent: true } : {}) })
    if (!silent) { setLoading(true); setError(null) }
    // A failed read must not look like "no lead is set": those are different facts,
    // and showing the second when the first happened is a silent lie.
    void fetchTeamLead(session).then((result) => setLeadMemberId(result.leadMemberId)).catch(() => { if (!silent) setNotice(t('leadLoadFailed')) })
    void fetchTeamSnapshot(session).then((next) => {
      setSnapshot((current) => {
        // A background poll that changes nothing must not replace the snapshot: rebuilding
        // the drafts from it would wipe whatever the human is typing into a name or role.
        if (memberSignature(current) === memberSignature(next)) return current
        setRoleDrafts(Object.fromEntries(next.members.map((member) => [member.memberId, member.role])))
        setNameDrafts(Object.fromEntries(next.members.map((member) => [member.memberId, member.displayName])))
        return next
      })
    }).catch((cause: unknown) => {
      if (!silent) setError(cause instanceof LiveTeamsApiError ? cause : new LiveTeamsApiError(500, t('loadFailed')))
    }).finally(() => { if (!silent) setLoading(false) })
  }, [refreshJournal, refreshRoles, session, t])

  const loadTeam = useCallback(() => {
    ;(globalThis as { __loads?: number }).__loads = ((globalThis as { __loads?: number }).__loads ?? 0) + 1
    setTeamLoading(true)
    void fetchTeamState(session).then((next) => {
      setTeamState(next)
      setBriefingText(next.briefing ?? '')
      setTeamNameDraft(next.teamName)
      if (!next.enabled) {
        setAdoptionLoading(true)
        void fetchTeamAdoptionCandidates(session).then((result) => setAdoptionCandidates(result.candidates)).catch(() => setAdoptionCandidates([])).finally(() => setAdoptionLoading(false))
      } else setAdoptionCandidates([])
    }).catch(() => { setTeamState(null) }).finally(() => setTeamLoading(false))
  }, [session])

  useEffect(() => {
    void fetchTeamLead(session).then((result) => setLeadMemberId(result.leadMemberId)).catch(() => {})
  }, [session])
  useEffect(() => { loadTeam() }, [loadTeam])

  /**
   * The archive itself is expensive — every relay the human ever received — so it
   * is read only when unfolded. The folded header needs one number, and asking
   * the attention projection for it keeps that number identical to the chip's.
   */
  useEffect(() => {
    if (!inboxExpanded) return undefined
    refreshInbox()
    return undefined
  }, [inboxExpanded, refreshInbox])

  useEffect(() => {
    // A view without a Session still works against the pinned team, exactly like
    // every other read in this tab, so the count is not gated on a Session id.
    let active = true
    const read = (): void => {
      void fetchTeamAttention(session).then((result) => {
        if (active) setAttentionWaiting(result.attention.reduce((sum, entry) => sum + entry.waiting, 0))
      }).catch(() => { if (active) setAttentionWaiting(0) })
    }
    read()
    const timer = setInterval(read, 20000)
    return () => { active = false; clearInterval(timer) }
  }, [session])

  /**
   * The panel used to be a snapshot: a task that finished stayed in `Active` until the
   * human switched filters or reloaded, because nothing ever re-read the list. The host
   * offers no push channel for these reads, so the tab polls — but only while it is
   * visible, and silently, so the list never flashes.
   */
  useEffect(() => {
    if (teamState?.enabled !== true) return
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.hidden === true) return
      refreshTasks(taskFilter === 'archived', { silent: true })
      refreshJournal({ silent: true })
    }
    // Adaptive: while an attempt is live the panel should feel immediate, and when the team is idle
    // there is nothing to see — a fixed four seconds spent the same on both. A self-rescheduling
    // timeout rather than an interval, so the delay can change without rebuilding the timer.
    const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
    const schedule = (): void => {
      const busy = busyRef.current
      timer.current = setTimeout(() => { tick(); schedule() }, props.pollMs ?? (busy ? 2000 : 12000))
    }
    schedule()
    const onVisible = (): void => { if (document.hidden !== true) tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { if (timer.current !== undefined) clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVisible) }
  }, [teamState?.enabled, taskFilter, refreshTasks, refreshJournal, props.pollMs])

  // Members, roles and the lead change far slower than tasks, so they refresh less often.
  useEffect(() => {
    if (teamState?.enabled !== true) return
    const timer = setInterval(() => { if (document.hidden !== true) refresh({ silent: true }) }, 20000)
    return () => clearInterval(timer)
  }, [teamState?.enabled, refresh])

  // Members and roles belong to a team that exists and is switched on: a
  // disabled team answers only its own status, on purpose.
  useEffect(() => {
    if (teamState?.enabled === true) {
      refresh()
      refreshTasks()
    }
  }, [teamState?.enabled, refresh, refreshTasks])

  useEffect(() => {
    if (teamState?.enabled === true) refreshTasks(taskFilter === 'archived')
  }, [taskFilter, teamState?.enabled, refreshTasks])

  const loadTaskDetail = (summary: TaskSummary): void => {
    setTaskExpanded(summary.id)
    if (taskDetails[summary.id] !== undefined) return
    setTaskLoading(true)
    void fetchTeamTask(summary.id, session).then((detail) => setTaskDetails((current) => ({ ...current, [summary.id]: detail }))).catch((cause: unknown) => setTaskNotice(cause instanceof LiveTeamsApiError ? cause.error : t('taskLoadFailed'))).finally(() => setTaskLoading(false))
  }

  const openNewTask = (): void => {
    setDraftTitle(''); setDraftKind('implementation'); setDraftAssignee(members[0]?.memberId ?? ''); setDraftRoute('report')
    setDraftReviewer(''); setDraftPaths(''); setDraftAcceptance(''); setDraftChecks(''); setDraftBody('')
    setTaskDraft({})
  }

  const openContract = (summary: TaskSummary, detail: TeamTaskDetail | undefined): void => {
    setDraftTitle(summary.title)
    setDraftKind(detail?.task.kind ?? 'implementation')
    setDraftAssignee(detail?.task.assignee ?? summary.assignee ?? '')
    setDraftRoute(summary.route?.type === 'review' ? 'review' : 'report')
    setDraftReviewer(summary.route?.type === 'review' ? summary.route.reviewer : '')
    setDraftPaths((summary.paths ?? []).join(', '))
    setDraftAcceptance((detail?.task.acceptance ?? []).join('\n'))
    setDraftChecks((detail?.task.checks ?? []).join('\n'))
    setDraftBody(detail?.document ?? '')
    setTaskDraft({ editing: summary.id })
  }

  const lines = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)

  const saveDraft = (): void => {
    if (draftBusy || draftTitle.trim().length === 0 || draftAssignee.length === 0 || lines(draftAcceptance).length === 0) return
    if (draftRoute === 'review' && draftReviewer.length === 0) return
    setDraftBusy(true)
    setTaskNotice(null)
    const route = draftRoute === 'review' ? { type: 'review', reviewer: draftReviewer } : { type: 'report', to: 'human' }
    const paths = draftPaths.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    const request = taskDraft?.editing === undefined
      ? createTeamTask({
          title: draftTitle.trim(), kind: draftKind, assignee: draftAssignee, acceptance: lines(draftAcceptance), route,
          ...(paths.length === 0 ? {} : { paths }),
          ...(lines(draftChecks).length === 0 ? {} : { checks: lines(draftChecks) }),
          ...(draftBody.trim().length === 0 ? {} : { body: draftBody }),
        }, session)
      : updateTeamTask({
          taskId: taskDraft.editing, title: draftTitle.trim(), assignee: draftAssignee, acceptance: lines(draftAcceptance),
          ...(paths.length === 0 ? {} : { paths }),
          ...(lines(draftChecks).length === 0 ? {} : { checks: lines(draftChecks) }),
          ...(draftBody.trim().length === 0 ? {} : { body: draftBody }),
        }, session)
    void request.then(() => {
      setTaskDraft(null)
      setTaskNotice(t('taskSaved'))
      refreshTasks(taskFilter === 'archived')
    }).catch((cause: unknown) => setTaskNotice(cause instanceof LiveTeamsApiError ? cause.error : t('taskActionFailed'))).finally(() => setDraftBusy(false))
  }

  const releaseAttempt = (): void => {
    if (releaseTarget === null || draftBusy || releaseReason.trim().length === 0) return
    setDraftBusy(true)
    setTaskNotice(null)
    void revokeTeamTask({ taskId: releaseTarget.id, reason: releaseReason.trim() }, session).then(() => {
      setReleaseTarget(null)
      setReleaseReason('')
      setTaskNotice(t('taskReleased'))
      refreshTasks(taskFilter === 'archived')
    }).catch((cause: unknown) => setTaskNotice(cause instanceof LiveTeamsApiError ? cause.error : t('taskActionFailed'))).finally(() => setDraftBusy(false))
  }

  const runTaskAction = (kind: 'accept' | 'revise', summary: TaskSummary): void => {
    if (taskBusy !== null) return
    setTaskBusy(summary.id)
    setTaskNotice(null)
    const request = kind === 'accept' ? acceptTeamTask(summary.id, taskNote.trim().length === 0 ? undefined : taskNote.trim(), session) : reviseTeamTask(summary.id, taskInstructions.trim(), session)
    void request.then(() => {
      setTaskConfirm(null)
      setTaskNote('')
      setTaskInstructions('')
      setTaskDetails((current) => { const next = { ...current }; delete next[summary.id]; return next })
      refreshTasks(taskFilter === 'archived')
    }).catch((cause: unknown) => setTaskNotice(cause instanceof LiveTeamsApiError ? cause.error : t('taskActionFailed'))).finally(() => setTaskBusy(null))
  }

  const sendMessage = (): void => {
    if (messageBusy || messageKind === '' || messageTo.length === 0 || messageContent.trim().length === 0) return
    setMessageBusy(true)
    setNotice(null)
    void sendTeamMessage({ to: messageTo, kind: messageKind, content: messageContent }, session).then((result) => {
      const failed = result.deliveries.find((delivery) => delivery.state === 'failed' && delivery.failure !== undefined)
      setMessageContent('')
      setMessageKind('')
      setNotice(failed === undefined ? t('messageSent') : `${t('messageDeliveryFailed')}: ${failed.recipient} — ${failed.failure}`)
      refreshInbox()
    }).catch((cause: unknown) => {
      setNotice(cause instanceof LiveTeamsApiError ? cause.error : t('messageSendFailed'))
    }).finally(() => setMessageBusy(false))
  }

  const acknowledgeMessage = (message: TeamInboxMessage): void => {
    if (message.delivery.state === 'acknowledged') return
    void acknowledgeTeamMessage(message.id, session).then(() => refreshInbox()).catch(() => setNotice(t('messageAcknowledgeFailed')))
  }

  const applyTeamName = (): void => {
    if (teamState === null || teamBusy) return
    setTeamBusy(true)
    void renameTeam(teamNameDraft, teamState.revision ?? 0, session).then((next) => {
      setTeamState(next)
      setEditingTeamName(false)
      setNotice(t('teamRenamed'))
    }).catch(() => setNotice(t('teamActionFailed'))).finally(() => setTeamBusy(false))
  }

  const applyEnable = (createNew = false): void => {
    if (teamBusy) return
    setTeamBusy(true)
    void enableTeam(teamNameDraft.length === 0 ? undefined : teamNameDraft, session, createNew).then((next) => {
      setTeamState(next)
      setNotice(t('teamEnabled'))
    }).catch((cause: unknown) => {
      if (cause instanceof LiveTeamsApiError && cause.status === 409) setNotice(t('existingTeamFound'))
      else setNotice(t('teamActionFailed'))
    }).finally(() => setTeamBusy(false))
  }

  const applyAdopt = (candidate: TeamAdoptionCandidate): void => {
    if (teamBusy || candidate.usable === false) return
    setTeamBusy(true)
    // The derived directory may already exist as an empty team, created by an
    // earlier enable. Replacing it is allowed, and only when it holds nobody:
    // a populated team is never touched, and the host refuses that outright.
    const replaceEmptyDerived = teamState !== null && teamState.enabled === false && (teamState.memberCount ?? 0) === 0
    void adoptTeam(candidate.teamId, replaceEmptyDerived, session).then((next) => {
      setTeamState(next)
      setAdoptionCandidates([])
      setNotice(`${t('teamAdopted')}: ${candidate.name ?? candidate.teamId}`)
    }).catch(() => setNotice(t('teamActionFailed'))).finally(() => setTeamBusy(false))
  }

  const applyDisable = (): void => {
    if (teamBusy) return
    setTeamBusy(true)
    void disableTeam(session).then((next) => {
      setTeamState(next)
      setDisableConfirm(false)
      setNotice(t('teamDisabled'))
    }).catch(() => setNotice(t('teamActionFailed'))).finally(() => setTeamBusy(false))
  }

  const loadCandidates = useCallback(() => {
    setCandidateLoading(true)
    void fetchTeamCandidates(session).then((result) => {
      setCandidates(result.candidates)
      setCandidateTeamName(result.teamName)
      const first = result.candidates[0]
      setSelectedSessionId(first?.sessionId ?? null)
      setAddName(memberNameFromTitle(first?.title, result.teamName))
    }).catch(() => {
      setCandidates([])
      setCandidateTeamName('')
      setSelectedSessionId(null)
      setNotice(t('addMemberFailed'))
    }).finally(() => setCandidateLoading(false))
  }, [t])

  const openAddMember = (): void => {
    setAddOpen(true)
    setNotice(null)
    setAddName('')
    setAddRole('')
    setSelectedSessionId(null)
    loadCandidates()
  }

  /** The name the dialog fills in itself; anything else is the human's own typing. */
  const defaultMemberName = (candidate: TeamCandidate): string => memberNameFromTitle(candidate.title, candidateTeamName)

  const chooseCandidate = (candidate: TeamCandidate): void => {
    setSelectedSessionId(candidate.sessionId)
    setAddName(defaultMemberName(candidate))
  }

  const selectedCandidate = candidates.find((candidate) => candidate.sessionId === selectedSessionId)
  const chooseNewSession = (): void => {
    if (selectedCandidate === undefined || addName === defaultMemberName(selectedCandidate)) setAddName('')
    setSelectedSessionId(null)
  }
  const roleOptions = roleData?.roles ?? []
  const roleById = new Map<string, TeamRoles['roles'][number]>(roleOptions.map((role) => [role.id, role]))
  const canSaveMember = addName.trim().length > 0 && addRole.trim().length > 0 && roleById.has(addRole) && !addBusy && !candidateLoading

  const createMember = (): void => {
    if (snapshot === null || !canSaveMember) return
    setAddBusy(true)
    setNotice(null)
    const request = selectedCandidate === undefined
      ? createTeamSessionMember({ displayName: addName, role: addRole, expectedRevision: snapshot.revision }, session)
      : addTeamMember({ sessionId: selectedCandidate.sessionId, displayName: addName, role: addRole, expectedRevision: snapshot.revision }, session)
    void request.then(() => {
      setAddOpen(false)
      setNotice(t('memberCreated'))
      refresh()
    }).catch((cause: unknown) => {
      if (cause instanceof LiveTeamsApiError && cause.status === 409 && cause.conflict !== null) {
        setSnapshot((current) => current === null ? current : { ...current, revision: cause.conflict?.revision ?? current.revision, members: cause.conflict?.members ?? current.members })
        setRoleDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.role])))
        setNameDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.displayName])))
        setNotice(t('teamChanged'))
      } else setNotice(addMemberFailure(cause, t))
    }).finally(() => setAddBusy(false))
  }

  useEffect(() => {
    if (editingName !== null) nameInputRef.current?.focus()
    else if (focusAfterNameEdit.current !== null) {
      const memberId = focusAfterNameEdit.current
      if (busy.has(memberId)) return
      focusAfterNameEdit.current = null
      nameEditButtons.current[memberId]?.focus()
    }
  }, [busy, editingName])

  const openMember = (member: TeamMember): void => {
    if (member.sessionId !== null) props.ctx?.sessions.open(member.sessionId)
  }

  /**
   * One member panel at a time: the ribbon keeps its layout, so a second open
   * panel would only push the rest of the tab down. Clicking the open member
   * again closes it.
   */
  const toggleMemberPanel = (memberId: string): void => {
    setExpandedMembers((current) => current.has(memberId) ? new Set() : new Set([memberId]))
  }

  const beginNameEdit = (member: TeamMember): void => {
    if (busy.has(member.memberId)) return
    setNameDrafts((current) => ({ ...current, [member.memberId]: member.displayName }))
    setEditingName(member.memberId)
    setNotice(null)
  }

  const cancelNameEdit = (member: TeamMember): void => {
    setNameDrafts((current) => ({ ...current, [member.memberId]: member.displayName }))
    focusAfterNameEdit.current = member.memberId
    setEditingName(null)
  }

  const applyName = (member: TeamMember): void => {
    if (snapshot === null || busy.has(member.memberId)) return
    const displayName = nameDrafts[member.memberId] ?? member.displayName
    if (displayName.trim().length === 0) return
    setBusy((current) => new Set(current).add(member.memberId))
    setNotice(null)
    void changeMemberDisplayName(member.memberId, displayName, snapshot.revision, session).then((result) => {
      setSnapshot((current) => current === null ? current : { ...current, revision: result.revision, members: current.members.map((entry) => entry.memberId === result.memberId ? result.member : entry) })
      setNameDrafts((current) => ({ ...current, [result.memberId]: result.member.displayName }))
      focusAfterNameEdit.current = member.memberId
      setEditingName(null)
    }).catch((cause: unknown) => {
      if (cause instanceof LiveTeamsApiError && cause.status === 409 && cause.conflict !== null) {
        setSnapshot((current) => current === null ? current : { ...current, revision: cause.conflict?.revision ?? current.revision, members: cause.conflict?.members ?? current.members })
        setRoleDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.role])))
        setNameDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.displayName])))
        focusAfterNameEdit.current = member.memberId
        setEditingName(null)
        setNotice(t('teamChanged'))
      } else setNotice(t('mutationFailed'))
    }).finally(() => setBusy((current) => { const next = new Set(current); next.delete(member.memberId); return next }))
  }

  const applyRole = (member: TeamMember): void => {
    if (snapshot === null || busy.has(member.memberId)) return
    const role = roleDrafts[member.memberId] ?? member.role
    setBusy((current) => new Set(current).add(member.memberId))
    setNotice(null)
    void changeMemberRole(member.memberId, role, snapshot.revision, session).then((result) => {
      setSnapshot((current) => current === null ? current : { ...current, revision: result.revision, members: current.members.map((entry) => entry.memberId === result.memberId ? result.member : entry) })
      setRoleDrafts((current) => ({ ...current, [result.memberId]: result.member.role }))
    }).catch((cause: unknown) => {
      if (cause instanceof LiveTeamsApiError && cause.status === 409 && cause.conflict !== null) {
        setSnapshot((current) => current === null ? current : { ...current, revision: cause.conflict?.revision ?? current.revision, members: cause.conflict?.members ?? current.members })
        setRoleDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.role])))
        setNotice(t('teamChanged'))
      } else setNotice(t('mutationFailed'))
    }).finally(() => setBusy((current) => { const next = new Set(current); next.delete(member.memberId); return next }))
  }

  const openRolesPath = (scope: 'global' | 'workspace', id?: string): void => {
    setNotice(null)
    void openTeamRoles(scope, id, session).then(() => setNotice(t('rolesOpened'))).catch(() => setNotice(t('openRolesFailed')))
  }

  const customizeRole = (id: string): void => {
    if (roleBusy.has(id)) return
    setRoleBusy((current) => new Set(current).add(id))
    setNotice(null)
    void overrideTeamRole(id, session).then(() => {
      setNotice(t('roleOverridden'))
      refreshRoles()
    }).catch((cause: unknown) => {
      setNotice(cause instanceof LiveTeamsApiError && cause.status === 409 ? t('roleAlreadyOverridden') : t('overrideFailed'))
    }).finally(() => setRoleBusy((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    }))
  }

  const toggleAvailability = (member: TeamMember): void => {
    if (snapshot === null || busy.has(member.memberId)) return
    const availability = member.availability === 'paused' ? 'available' : 'paused'
    setBusy((current) => new Set(current).add(member.memberId))
    setNotice(null)
    void changeMemberAvailability(member.memberId, availability, snapshot.revision, session).then((result) => {
      setSnapshot((current) => current === null ? current : { ...current, revision: result.revision, members: current.members.map((entry) => entry.memberId === result.memberId ? result.member : entry) })
    }).catch((cause: unknown) => {
      if (cause instanceof LiveTeamsApiError && cause.status === 409 && cause.conflict !== null) {
        setSnapshot((current) => current === null ? current : { ...current, revision: cause.conflict?.revision ?? current.revision, members: cause.conflict?.members ?? current.members })
        setRoleDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.role])))
        setNotice(t('teamChanged'))
      } else setNotice(t('mutationFailed'))
    }).finally(() => setBusy((current) => { const next = new Set(current); next.delete(member.memberId); return next }))
  }

  const confirmInterruptTurn = (): void => {
    if (interruptTarget === null || interruptBusy) return
    // Nothing to interrupt is a fact worth saying: the button used to return here in silence,
    // so pressing it on an idle member did nothing at all — no request, no notice, and no
    // journal entry (F18 of the third live run).
    if (interruptTarget.sessionId === null || interruptTarget.status !== 'running') {
      setNotice(t('noRunningTurn'))
      setInterruptTarget(null)
      return
    }
    const target = interruptTarget
    setInterruptBusy(true)
    setNotice(null)
    void interruptTeamMember(target.memberId, session).then((result) => {
      setSnapshot((current) => current === null ? current : { ...current, members: current.members.map((entry) => entry.memberId === result.memberId ? { ...entry, status: result.status } : entry) })
      setInterruptTarget(null)
      setNotice(t('turnInterrupted'))
    }).catch((cause: unknown) => {
      if (cause instanceof LiveTeamsApiError && cause.status === 409) setNotice(t('noRunningTurn'))
      else setNotice(t('interruptFailed'))
    }).finally(() => setInterruptBusy(false))
  }

  const confirmRemoveMember = (): void => {
    if (snapshot === null || removeTarget === null || removeBusy) return
    const target = removeTarget
    setRemoveBusy(true)
    setNotice(null)
    void removeTeamMember(target.memberId, snapshot.revision, session).then((result) => {
      setSnapshot((current) => current === null ? current : { ...current, revision: result.revision, members: current.members.filter((entry) => entry.memberId !== result.memberId) })
      setRoleDrafts((current) => { const next = { ...current }; delete next[result.memberId]; return next })
      setNameDrafts((current) => { const next = { ...current }; delete next[result.memberId]; return next })
      setRemoveTarget(null)
      setNotice(t('memberRemoved'))
    }).catch((cause: unknown) => {
      if (cause instanceof LiveTeamsApiError && cause.status === 409 && cause.conflict !== null) {
        setSnapshot((current) => current === null ? current : { ...current, revision: cause.conflict?.revision ?? current.revision, members: cause.conflict?.members ?? current.members })
        setRoleDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.role])))
        setNameDrafts(Object.fromEntries(cause.conflict.members.map((entry) => [entry.memberId, entry.displayName])))
        setRemoveTarget(null)
        setNotice(t('teamChanged'))
      } else setNotice(t('mutationFailed'))
    }).finally(() => setRemoveBusy(false))
  }

  // The team state decides first: a team that is switched off has no members to
  // wait for, and its view must not be hidden behind the member loading gate.
  if (teamState !== null && !teamState.enabled) {
    return (
      <section className="dshLiveTeamsRoot" aria-label={t('title')}>
        {teamState?.compatibility === undefined || teamState.compatibility.verdict === 'compatible' ? null : (
          <p className={`dshLiveTeamsNotice dshLiveTeamsCompatibility${teamState.compatibility.verdict === 'incompatible' ? ' dshLiveTeamsCompatibilityBad' : ''}`} role="status">
            {teamState.compatibility.verdict === 'incompatible' ? t('compatibilityIncompatible') : t('compatibilityDegraded')}
            {teamState.compatibility.hostVersion === undefined ? '' : ` · DSH ${teamState.compatibility.hostVersion}`}
            {' — '}{teamState.compatibility.detail}
          </p>
        )}
        <section className="dshLiveTeamsCard">
          <div className="dshLiveTeamsSectionHeader">
            <h2>{t('teamOffTitle')}</h2>
            <p className="dshLiveTeamsSectionCaption">{t('teamOffHint')}</p>
            {/* The panel belongs to the Session that is open, which is not the
                workspace highlighted in the sidebar. Name it, so nobody has to
                guess which workspace is being described. */}
            <p className="dshLiveTeamsWorkspacePath">{teamState.workspacePath}</p>
          </div>
          {/* Switching this workspace's own team on is always the primary action.
              Offering adoption instead of it once hid the only way back for a
              team that had merely been disabled. */}
          <label className="dshLiveTeamsModalField">
            <span className="dshLiveTeamsFieldLabel">{t('teamNameLabel')}</span>
            <input type="text" value={teamNameDraft} disabled={teamBusy} onChange={(event) => setTeamNameDraft(event.target.value)} />
          </label>
          <button className="dshLiveTeamsTeamToggle" type="button" disabled={teamBusy} onClick={() => applyEnable()}>{t('enableTeam')}</button>
          {adoptionLoading ? <p className="dshLiveTeamsMessage">{t('loading')}</p> : adoptionCandidates.length > 0 ? <div className="dshLiveTeamsAdoptionList">
            <p className="dshLiveTeamsMessage">{t('existingTeamHint')}</p>
            {adoptionCandidates.map((candidate) => <div className="dshLiveTeamsAdoptionRow" key={candidate.teamId}>
              <span><strong>{candidate.name ?? candidate.teamId}</strong> — {candidate.usable === false ? candidate.reason ?? t('candidateUnusable') : `${candidate.memberCount ?? 0} ${t('members').toLowerCase()}`}</span>
              <button className="dshLiveTeamsTeamToggle" type="button" disabled={teamBusy || candidate.usable === false} onClick={() => applyAdopt(candidate)}>{t('adoptTeam')}</button>
            </div>)}
            <button className="dshLiveTeamsTeamToggle" type="button" disabled={teamBusy} onClick={() => applyEnable(true)}>{t('createNewTeam')}</button>
          </div> : null}
        </section>
        {notice !== null && <p className="dshLiveTeamsNotice" role="status">{notice}</p>}
      </section>
    )
  }
  if (teamLoading && teamState === null) return <section className="dshLiveTeamsRoot"><p className="dshLiveTeamsMessage">{t('loading')}</p></section>
  if (loading && snapshot === null) return <section className="dshLiveTeamsRoot"><p className="dshLiveTeamsMessage">{t('loading')}</p></section>
  if (error?.status === 503) return <section className="dshLiveTeamsRoot"><p className="dshLiveTeamsMessage">{t('unavailable')}</p><Button variant="outline" size="sm" type="button" onClick={() => refresh()}>{t('refresh')}</Button></section>
  if (error !== null && snapshot === null) return <section className="dshLiveTeamsRoot"><p className="dshLiveTeamsMessage">{t('loadFailed')}</p><Button variant="outline" size="sm" type="button" onClick={() => refresh()}>{t('refresh')}</Button></section>

  const members = snapshot?.members ?? []
  const liveCount = members.filter((member) => member.live).length
  const pausedCount = members.filter((member) => member.availability === 'paused').length
  const unboundCount = members.filter((member) => member.sessionId === null).length
   const activeTaskCount = taskSummaries.filter(isActiveTask).length
   const awaitingLeadCount = taskSummaries.filter(awaitsLead).length
  const sectionTitleId = 'dsh-live-teams-members-title'
   const visibleJournal = journalFilters.size === 0 || journalFilters.size === journalCategories.length ? journal : journal.filter((entry) => journalFilters.has(entry.category))
   const toggleJournalFilter = (category: JournalCategory): void => {
     setJournalFilters((current) => {
       if (current.size === journalCategories.length) return new Set([category])
       const next = new Set(current)
       if (next.has(category)) next.delete(category)
       else next.add(category)
       return next
     })
   }
   const briefingSummary = (briefingText.split(/\r?\n/u)[0] ?? '').trim() || t('briefingEmpty')
   const formatJournalTime = (at: number): string => {
     try { return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(at)) } catch { return '—' }
   }

  return (
    <section className="dshLiveTeamsRoot" aria-label={t('title')}>
     <div className="dshLiveTeamsShell">
       <div className="dshLiveTeamsCols dshLiveTeamsHead">
      <section className="dshLiveTeamsCard dshLiveTeamsSummary" aria-labelledby="dsh-live-teams-summary-title">
        <div className="dshLiveTeamsSectionHeader">
          <h3 id="dsh-live-teams-summary-title">{t('summaryTitle')}</h3>
          
        </div>
        <dl className="dshLiveTeamsSummaryGrid">
          <Stat label={t('totalMembers')} value={members.length} />
          <Stat label={t('liveMembers')} value={liveCount} />
          <Stat label={t('pausedMembers')} value={pausedCount} />
          <Stat label={t('unboundMembers')} value={unboundCount} />
           <Stat label={t('activeTasks')} value={activeTaskCount} />
           <Stat label={t('awaitingLead')} value={awaitingLeadCount} />
        </dl>
      </section>
       <section className="dshLiveTeamsCard dshLiveTeamsTeamControls" aria-label={t('title')}>
      <div className="dshLiveTeamsHeader">
        <div className="dshLiveTeamsHeaderCopy">
          {editingTeamName ? (
            <span className="dshLiveTeamsNameLine">
              <input type="text" className="dshLiveTeamsNameInput" value={teamNameDraft} disabled={teamBusy} onChange={(event) => setTeamNameDraft(event.target.value)} aria-label={t('teamNameLabel')} />
              <span className="dshLiveTeamsNameActions">
                <Button variant="outline" size="sm" type="button" disabled={teamBusy || teamNameDraft.trim().length === 0} onClick={applyTeamName}>{t('save')}</Button>
                <Button variant="outline" size="sm" type="button" disabled={teamBusy} onClick={() => { setEditingTeamName(false); setTeamNameDraft(teamState?.teamName ?? '') }}>{t('cancel')}</Button>
              </span>
            </span>
          ) : (
            <h2>
              <span className="dshLiveTeamsNameLine">
                {teamState?.teamName ?? t('title')}
                <button className="dshLiveTeamsEditNameButton" type="button" onClick={() => setEditingTeamName(true)} aria-label={`${t('renameTeam')}: ${teamState?.teamName ?? ''}`} title={t('renameTeam')}>
                  <IconEditOutline16 size={14} />
                </button>
              </span>
            </h2>
          )}

        </div>
        <button className="dshLiveTeamsIconButton" type="button" onClick={() => refresh()} disabled={loading} aria-label={t('refresh')} title={t('refresh')}>
          <IconRefreshOutline16 />
        </button>
        <label className="dshLiveTeamsLeadControl"><span>{t('lead')}</span><select value={leadMemberId ?? ''} disabled={teamBusy} onChange={(event) => { setTeamBusy(true); void setTeamLead(event.target.value, session).then(() => { setLeadMemberId(event.target.value); setNotice(t('leadUpdated')) }).catch(() => setNotice(t('teamActionFailed'))).finally(() => setTeamBusy(false)) }}><option value="">{t('leadUnset')}</option>{members.map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}</select></label>
        <button className="dshLiveTeamsTeamToggle" type="button" disabled={teamBusy} onClick={() => setDisableConfirm(true)}>{t('disableTeam')}</button>
      </div>
      <section className={`dshLiveTeamsBriefing${briefingExpanded ? ' dshLiveTeamsPanelExpanded' : ''}`} aria-labelledby="dsh-live-teams-briefing-title"><button className="dshLiveTeamsCollapseHeader" type="button" aria-expanded={briefingExpanded} onClick={() => setBriefingExpanded((current) => !current)}><span className="dshLiveTeamsDisclosure" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span><span className="dshLiveTeamsCollapseHeaderCopy"><strong id="dsh-live-teams-briefing-title">{t('briefing')}</strong><span>{briefingExpanded ? t('briefingHint') : briefingSummary}</span></span></button><button className="dshLiveTeamsAddButton" type="button" onClick={() => { void openTeamBriefing(session).then(() => setNotice(t('briefingOpened'))).catch(() => setNotice(t('openBriefingFailed'))) }} disabled={teamState?.openAvailable !== true}>{t('openBriefing')}</button>{briefingExpanded && <pre>{briefingText || t('briefingEmpty')}</pre>}</section>
        <section className={`dshLiveTeamsRoles dshLiveTeamsControlDisclosure${rolesExpanded ? ' dshLiveTeamsPanelExpanded' : ''}`} aria-labelledby="dsh-live-teams-roles-title">
          <button className="dshLiveTeamsCollapseHeader" type="button" aria-expanded={rolesExpanded} onClick={() => setRolesExpanded((current) => !current)}><span className="dshLiveTeamsDisclosure" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span><span className="dshLiveTeamsCollapseHeaderCopy"><strong id="dsh-live-teams-roles-title">{t('roles')}</strong><span>{rolesExpanded ? t('rolesCaption') : `${roleOptions.length} ${t('rolesCount')}`}</span></span></button>
          {rolesExpanded && <>
          <div className="dshLiveTeamsRoleActions">
            {roleData !== null && roleData.globalOpenAvailable && <button className="dshLiveTeamsAddButton" type="button" onClick={() => openRolesPath('global')} aria-label={t('openGlobalRoles')}>{t('openGlobalRoles')}</button>}
            {roleData !== null && canOpenWorkspaceRoles(roleData) && <button className="dshLiveTeamsAddButton" type="button" onClick={() => openRolesPath('workspace')} aria-label={t('openWorkspaceRoles')}>{t('openWorkspaceRoles')}</button>}
          </div>
          {roleLoading && roleData === null ? <p className="dshLiveTeamsMessage">{t('loading')}</p> : roleData !== null && (
            <ul className="dshLiveTeamsRoleList">
              {roleData.roles.map((role) => {
                const customized = role.source === 'workspace' || role.overridden
                const roleActionLabel = customized ? `${t('openRoleFile')}: ${role.name}` : `${t('customizeRole')}: ${role.name}`
                return <li className="dshLiveTeamsRoleRow" key={role.id}>
                  <div className="dshLiveTeamsRoleIdentity">
                    <strong className="dshLiveTeamsRoleName">{role.name}</strong>
                    <span className="dshLiveTeamsRoleState">{customized ? t('roleCustomized') : t('roleGlobal')}</span>
                  </div>
                  {customized ? roleData.openAvailable ? <button className="dshLiveTeamsAddButton" type="button" disabled={roleBusy.has(role.id)} onClick={() => openRolesPath('workspace', role.id)} aria-label={roleActionLabel}>{t('openRoleFile')}</button> : null : <button className="dshLiveTeamsAddButton" type="button" disabled={roleBusy.has(role.id)} onClick={() => customizeRole(role.id)} aria-label={roleActionLabel}>{t('customizeRole')}</button>}
                </li>
              })}
            </ul>
          )}

          </>}        </section>
       <Modal open={disableConfirm} onClose={() => { if (!teamBusy) setDisableConfirm(false) }} title={t('disableTeamTitle')} closeLabel={t('cancel')} description={`${t('disableTeamDescription')} ${t('sessionContinues')}`} footer={<><Button variant="outline" size="sm" type="button" disabled={teamBusy} onClick={() => setDisableConfirm(false)}>{t('cancel')}</Button><Button variant="primary" size="sm" type="button" disabled={teamBusy} onClick={applyDisable}>{t('disableTeam')}</Button></>}>
        {<p className="dshLiveTeamsMessage">{t('disableTeamKeeps')}</p>}
      </Modal>
      {notice !== null && <p className="dshLiveTeamsNotice" role="status">{notice}</p>}
       </section>
       </div>
      <section className="dshLiveTeamsCard dshLiveTeamsMembers" aria-labelledby={sectionTitleId}>
        <div className="dshLiveTeamsSectionHeader">
          <h3 id={sectionTitleId}>{t('membersTitle')}</h3>
          <p className="dshLiveTeamsSectionCaption">{t('membersCaption')}</p>
        </div>
        <button className="dshLiveTeamsAddButton" type="button" onClick={openAddMember} aria-label={t('addMember')}>
          <IconPlusOutline16 size={14} />
          <span>{t('addMember')}</span>
        </button>
        <Modal open={addOpen} onClose={() => { if (!addBusy) setAddOpen(false) }} title={t('addMemberTitle')} closeLabel={t('cancel')} description={t('addMemberDescription')} footer={<><Button variant="outline" size="sm" type="button" disabled={addBusy} onClick={() => setAddOpen(false)}>{t('cancel')}</Button><Button variant="primary" size="sm" type="button" disabled={!canSaveMember} onClick={createMember}>{t('createMember')}</Button></>}>
          {candidateLoading ? <p className="dshLiveTeamsMessage">{t('loading')}</p> : <div className="dshLiveTeamsAddForm">
            <fieldset className="dshLiveTeamsCandidateList">
              <legend className="dshLiveTeamsFieldLabel">{t('candidateSession')}</legend>
              {candidates.length === 0 && <p className="dshLiveTeamsMessage">{t('candidatesEmpty')}</p>}
              {candidates.map((candidate) => <label className="dshLiveTeamsCandidate" key={candidate.sessionId}>
                <input type="radio" name="dsh-live-teams-candidate" checked={candidate.sessionId === selectedSessionId} disabled={addBusy} onChange={() => chooseCandidate(candidate)} />
                <span className="dshLiveTeamsCandidateCopy"><strong>{candidate.title ?? candidate.sessionId}</strong><span>{candidate.sessionId}</span><span className="dshLiveTeamsCandidateState">{t('candidateState')}: {candidate.status === 'running' ? t('running') : candidate.status === 'idle' ? t('idle') : t('unknown')}</span></span>
              </label>)}
              <label className="dshLiveTeamsCandidate">
                <input type="radio" name="dsh-live-teams-candidate" checked={selectedSessionId === null} disabled={addBusy} onChange={chooseNewSession} />
                <span className="dshLiveTeamsCandidateCopy"><strong>{t('candidateNewSession')}</strong><span className="dshLiveTeamsCandidateState">{t('candidateNewSessionHint')}</span></span>
              </label>
            </fieldset>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('name')}</span><input type="text" value={addName} disabled={addBusy} onChange={(event) => setAddName(event.target.value)} /></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('role')}</span><select value={addRole} disabled={addBusy || roleLoading} onChange={(event) => setAddRole(event.target.value)}><option value="">{t('chooseRole')}</option>{roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
          </div>}
        </Modal>
        <Modal open={interruptTarget !== null} onClose={() => { if (!interruptBusy) setInterruptTarget(null) }} title={t('interruptTurnTitle')} closeLabel={t('cancel')} description={t('interruptTurnDescription')} footer={<><Button variant="outline" size="sm" type="button" disabled={interruptBusy} onClick={() => setInterruptTarget(null)}>{t('cancel')}</Button><Button variant="primary" size="sm" type="button" disabled={interruptBusy || interruptTarget?.status !== 'running'} onClick={confirmInterruptTurn}>{t('interruptTurn')}</Button></>}>
          {interruptTarget !== null && <p className="dshLiveTeamsMessage">{interruptTarget.status === 'running' ? t('interruptTurnKeeps') : t('noRunningTurn')}</p>}
        </Modal>
        <Modal open={removeTarget !== null} onClose={() => { if (!removeBusy) setRemoveTarget(null) }} title={t('removeMemberTitle')} closeLabel={t('cancel')} description={`${t('removeMemberDescription')} ${t('sessionContinues')}`} footer={<><Button variant="outline" size="sm" type="button" disabled={removeBusy} onClick={() => setRemoveTarget(null)}>{t('cancel')}</Button><Button variant="primary" size="sm" type="button" disabled={removeBusy} onClick={confirmRemoveMember}>{t('removeMemberConfirm')}</Button></>}>
          {removeTarget !== null && <p className="dshLiveTeamsMessage">{t('auditRecorded')}</p>}
        </Modal>
        {members.length === 0 ? <p className="dshLiveTeamsMessage">{t('empty')}</p> : (
          <ul className="dshLiveTeamsRows">
            {members.map((member) => {
              const expanded = expandedMembers.has(member.memberId)
              const paused = member.availability === 'paused'
              return <li className={`dshLiveTeamsRow${expanded ? ' dshLiveTeamsRowSelected' : ''}`} data-role={member.role} key={member.memberId}>
                <details open={expanded}><summary className="dshLiveTeamsMemberCollapsed" aria-expanded={expanded} onClick={() => toggleMemberPanel(member.memberId)}><span className="dshLiveTeamsDisclosure" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span><strong className="dshLiveTeamsMemberName">{member.displayName}</strong><span className="dshLiveTeamsMemberChip">{member.role}</span><span className="dshLiveTeamsMemberChip">{paused ? t('pausedState') : member.availability === 'available' ? t('available') : member.availability}</span><span className={`dshLiveTeamsMemberLive${member.live ? ' dshLiveTeamsMemberLiveOn' : ''}`}>● {member.live ? t('live') : t('notLive')}</span><span className="dshLiveTeamsMemberNote">{member.note ?? t('noNote')}</span></summary></details>
              </li>
            })}
          </ul>
        )}
        {members.filter((member) => expandedMembers.has(member.memberId)).map((member) => {
          const rowBusy = busy.has(member.memberId)
          const editing = editingName === member.memberId
          const roleInputId = `dsh-live-teams-role-${member.memberId}`
          const nameInputId = `dsh-live-teams-name-${member.memberId}`
          const nameErrorId = `${nameInputId}-error`
          const paused = member.availability === 'paused'
          return <section className="dshLiveTeamsMemberPanel" data-role={member.role} data-member={member.memberId} aria-label={member.displayName} key={`panel-${member.memberId}`}>
            <div className="dshLiveTeamsMemberHeading">
              <div className="dshLiveTeamsMemberIdentity">
                {editing ? <><label className="dshLiveTeamsVisuallyHidden" htmlFor={nameInputId}>{t('name')}</label><input ref={nameInputRef} className="dshLiveTeamsNameInput" id={nameInputId} type="text" value={nameDrafts[member.memberId] ?? member.displayName} disabled={rowBusy || removeBusy} aria-invalid={(nameDrafts[member.memberId] ?? '').trim().length === 0} aria-describedby={nameErrorId} onChange={(event) => setNameDrafts((current) => ({ ...current, [member.memberId]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyName(member) } else if (event.key === 'Escape') { event.preventDefault(); cancelNameEdit(member) } }} /></> : null}
                {!editing && <Tooltip label={t('openSession')} disabled={member.sessionId === null}><button className="dshLiveTeamsMemberAction" type="button" disabled={member.sessionId === null} onClick={() => openMember(member)}><strong className="dshLiveTeamsMemberName">{member.displayName}</strong></button></Tooltip>}
                {!editing && <button className="dshLiveTeamsMemberOpen" type="button" disabled={member.sessionId === null} title={t('openSession')} onClick={() => openMember(member)}>{t('openSessionAction')}</button>}
                {!editing && <button ref={(element) => { nameEditButtons.current[member.memberId] = element }} className="dshLiveTeamsEditNameButton" type="button" disabled={rowBusy || removeBusy} onClick={() => beginNameEdit(member)} aria-label={t('editName')} title={t('editName')}><IconEditOutline16 size={14} /></button>}
                {editing && <div className="dshLiveTeamsNameActions"><Button variant="outline" size="sm" type="button" disabled={rowBusy || removeBusy || (nameDrafts[member.memberId] ?? '').trim().length === 0} onClick={() => applyName(member)}>{t('save')}</Button><Button variant="outline" size="sm" type="button" disabled={rowBusy || removeBusy} onClick={() => cancelNameEdit(member)}>{t('cancel')}</Button></div>}
                <span className="dshLiveTeamsState">
                  <span className="dshLiveTeamsStateDot"><StateDot state={stateDot(member)} /></span>
                  <span className="dshLiveTeamsStateLabel">{stateText(member, t)}</span>
                </span>
              </div>
              <div className="dshLiveTeamsMemberActions">
                <Tag className="dshLiveTeamsAvailabilityTag" tone="neutral">{paused ? t('pausedState') : member.availability === 'available' ? t('available') : member.availability}</Tag>
                <button className="dshLiveTeamsIconButton" type="button" disabled={rowBusy || removeBusy} onClick={() => toggleAvailability(member)} aria-label={paused ? t('resume') : t('pause')} title={paused ? t('resume') : t('pause')}>
                  {paused ? <IconPlayOutline16 size={14} /> : <IconPauseOutline16 size={14} />}
                </button>
                {!editing && member.status === 'running' && <button className="dshLiveTeamsInterruptButton" type="button" disabled={rowBusy || removeBusy || interruptBusy} onClick={() => setInterruptTarget(member)} aria-label={`${t('interruptTurn')}: ${member.displayName}`} title={t('interruptTurn')}>{t('interruptTurn')}</button>}
              </div>
            </div>
            {editing && (nameDrafts[member.memberId] ?? '').trim().length === 0 && <p className="dshLiveTeamsFieldError" id={nameErrorId}>{t('nameRequired')}</p>}
            <div className="dshLiveTeamsControls">
              <div className="dshLiveTeamsRoleField">
                <label className="dshLiveTeamsFieldLabel" htmlFor={roleInputId}>{t('role')}</label>
                <select className="dshLiveTeamsRoleInput" id={roleInputId} value={roleDrafts[member.memberId] ?? member.role} disabled={rowBusy || removeBusy || roleLoading} onChange={(event) => setRoleDrafts((current) => ({ ...current, [member.memberId]: event.target.value }))}><option value={member.role}>{roleById.has(member.role) ? roleById.get(member.role)?.name : `${member.role} (${t('unknownRole')})`}</option>{roleOptions.filter((role) => role.id !== member.role).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
              </div>
              <Button variant="outline" size="sm" className="dshLiveTeamsApply" type="button" disabled={rowBusy || removeBusy} onClick={() => applyRole(member)}>{t('apply')}</Button>
            </div>
            <div className="dshLiveTeamsContactGrant">
              <span className="dshLiveTeamsFieldLabel">{t('permittedContacts')}</span>
              <span className="dshLiveTeamsMetaValue">{(member.permittedContacts ?? []).join(', ') || t('noPeerContact')}</span>
              {member.memberId === leadMemberId && <div className="dshLiveTeamsGrantControls">
                <select className="dshLiveTeamsRoleInput dshLiveTeamsContactSelect" value={grantTarget} disabled={grantBusy !== null} onChange={(event) => setGrantTarget(event.target.value)}><option value="">{t('chooseContact')}</option>{members.filter((candidate) => candidate.memberId !== member.memberId).map((candidate) => <option key={candidate.memberId} value={candidate.memberId}>{candidate.displayName}</option>)}<option value="team">team</option><option value="human">human</option></select>
                <Button variant="outline" size="sm" type="button" disabled={grantBusy !== null || (grantTarget).length === 0} onClick={() => { const allow = grantTarget; setGrantBusy(member.memberId); void grantTeamContact({ memberId: member.memberId, allow, action: 'add' }, session).then(() => refresh()).catch((cause: unknown) => setNotice(cause instanceof LiveTeamsApiError ? cause.error : t('grantFailed'))).finally(() => setGrantBusy(null)) }}>{t('grant')}</Button>
                <Button variant="outline" size="sm" type="button" disabled={grantBusy !== null || (grantTarget).length === 0} onClick={() => { const allow = grantTarget; setGrantBusy(member.memberId); void grantTeamContact({ memberId: member.memberId, allow, action: 'remove' }, session).then(() => refresh()).catch((cause: unknown) => setNotice(cause instanceof LiveTeamsApiError ? cause.error : t('grantFailed'))).finally(() => setGrantBusy(null)) }}>{t('revoke')}</Button>
              </div>}
              {/* An absent control reads as a missing feature; say who owns it instead. */}
              {member.memberId !== leadMemberId && <span className="dshLiveTeamsFieldLabel">{t('contactGrantLeadOnly')}</span>}
            </div>
            <div className="dshLiveTeamsMemberMeta">
              <span className="dshLiveTeamsFieldLabel">{t('note')}</span><span className="dshLiveTeamsMetaValue">{member.note ?? t('noNote')}</span><span className="dshLiveTeamsFieldLabel">{t('binding')}</span>
              <span className="dshLiveTeamsMetaValue">{bindingLabel(member, t)}{member.sessionId === null ? '' : ` · ${member.sessionId}`}</span>
              <button className="dshLiveTeamsMemberRemove" type="button" disabled={rowBusy || removeBusy || interruptBusy} onClick={() => setRemoveTarget(member)} aria-label={`${t('removeMember')}: ${member.displayName}`} title={t('removeMember')}>{t('removeMember')}</button>
            </div>
          </section>
        })}
      </section>
       {notice !== null && <p className="dshLiveTeamsNotice" role="status">{notice}</p>}
       <div className="dshLiveTeamsCols dshLiveTeamsMain">
         <div className="dshLiveTeamsCol dshLiveTeamsMainLeft">
      <section className="dshLiveTeamsCard dshLiveTeamsJournal" aria-labelledby="dsh-live-teams-journal-title"><div className="dshLiveTeamsCardTitle"><h3 className="dshLiveTeamsCardTitleText" id="dsh-live-teams-journal-title">{t('journalTitle')}</h3><div className="dshLiveTeamsJournalControls"><button className={`dshLiveTeamsInboxButton${attentionWaiting > 0 ? ' dshLiveTeamsInboxButtonUnread' : ''}`} type="button" onClick={() => setInboxExpanded(true)}>{t('messagesTitle')}{attentionWaiting > 0 ? <span className="dshLiveTeamsInboxCount">{attentionWaiting}</span> : null}</button></div><div className="dshLiveTeamsSegmented dshLiveTeamsJournalFilters" role="group" aria-label={t('journalFilters')}>{journalCategories.map((category) => <button key={category} className={`dshLiveTeamsSegmentedButton dshLiveTeamsJournalFilter dshLiveTeamsJournalFilter-${category}${journalFilters.has(category) ? ' dshLiveTeamsSegmentedButtonActive dshLiveTeamsJournalFilterActive' : ''}`} type="button" aria-pressed={journalFilters.has(category)} onClick={() => toggleJournalFilter(category)}>{t(journalCategoryKeys[category])}<span className="dshLiveTeamsKindCount">{journal.filter((entry) => entry.category === category).length}</span></button>)}</div></div>{journalLoading ? <p className="dshLiveTeamsMessage">{t('loading')}</p> : visibleJournal.length === 0 ? <p className="dshLiveTeamsMessage">{t('journalEmpty')}</p> : <ul className="dshLiveTeamsJournalList">{visibleJournal.map((entry) => {
      const expanded = journalExpanded === entry.id
      return (
        <li className={`dshLiveTeamsJournalRow${expanded ? ' dshLiveTeamsJournalRowOpen' : ''}`} key={entry.id}>
          <button className="dshLiveTeamsJournalLine" type="button" aria-expanded={expanded} onClick={() => {
              setJournalExpanded(expanded ? null : entry.id)
              setJournalRaw(false)
              // A row about a task can show the contract itself: one read, only when opened, because
              // a hundred rows would otherwise mean a hundred document reads on every poll.
              const taskId = entry.refs.taskId
              if (!expanded && taskId !== undefined && journalTask[taskId] === undefined) {
                void fetchTeamTask(taskId, session).then((detail) => setJournalTask((current) => ({ ...current, [taskId]: detail }))).catch(() => undefined)
              }
            }}>
            <span className={`dshLiveTeamsJournalIcon dshLiveTeamsJournalIcon-${entry.category}`} aria-hidden="true">●</span>
            <span className={`dshLiveTeamsJournalKind dshLiveTeamsJournalKind-${entry.category}`}>{entry.kind}</span>
            <span className="dshLiveTeamsJournalSummary" title={entry.summary}>{entry.summaryParts === undefined ? entry.summary : entry.summaryParts.map((part, index) => part.strong === true ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>)}</span>
            <span className="dshLiveTeamsJournalRefs">{entry.refs.taskTitle !== undefined && <span className="dshLiveTeamsJournalTaskRef">{entry.refs.taskTitle}</span>}{entry.refs.taskId !== undefined && <span className="dshLiveTeamsJournalTaskId">{entry.refs.taskId}</span>}{entry.refs.round === undefined ? null : <span className="dshLiveTeamsJournalRoundRef">{t('journalRound')} {entry.refs.round}</span>}</span>
            <time className="dshLiveTeamsJournalTime" dateTime={new Date(entry.at).toISOString()}>{formatJournalTime(entry.at)}</time>
            <span className={`dshLiveTeamsJournalDisclosure${expanded ? ' dshLiveTeamsJournalDisclosureOpen' : ''}`} aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
          </button>
          {expanded && (
            <div className="dshLiveTeamsJournalDetailPanel">
              <dl className="dshLiveTeamsJournalFields">
                {(entry.fields ?? []).map((field) => (
                  <div className="dshLiveTeamsJournalField" key={`${field.label}:${field.value}`}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
              {entry.refs.taskId === undefined ? null : (
                <div className="dshLiveTeamsJournalBody">
                  <span className="dshLiveTeamsFieldLabel">{t('journalTask')}</span>
                  {(() => {
                    const detail = journalTask[entry.refs.taskId as string]
                    if (detail === undefined) return <p className="dshLiveTeamsJournalPending">{t('loading')}</p>
                    return (
                      <>
                        <p className="dshLiveTeamsJournalTaskLine"><strong>{detail.task.title}</strong> — {taskStatusLabel(detail.task.status, t)}</p>
                        {detail.task.acceptance.length === 0 ? null : <ul className="dshLiveTeamsJournalAcceptance">{detail.task.acceptance.map((item) => <li key={item}>{item}</li>)}</ul>}
                        {detail.documentMissing === true ? <p className="dshLiveTeamsJournalPending">{t('taskDocumentMissing')}</p> : journalRaw
                          ? <pre className="dshLiveTeamsJournalRaw dshLiveTeamsJournalRawTask">{detail.document}</pre>
                          : <div className="dshLiveTeamsJournalMarkdown"><MarkdownText text={detail.document} labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('markdownFootnotes') }} /></div>}
                      </>
                    )
                  })()}
                </div>
              )}
              {entry.detail === undefined ? null : (
                <div className="dshLiveTeamsJournalBody">
                  <div className="dshLiveTeamsJournalBodyHead">
                    <span className="dshLiveTeamsFieldLabel">{t('journalBody')}</span>
                    <button className="dshLiveTeamsJournalRawToggle" type="button" aria-pressed={journalRaw} onClick={() => setJournalRaw(!journalRaw)}>{journalRaw ? t('journalRendered') : t('journalRaw')}</button>
                  </div>
                  {journalRaw
                    ? <pre className="dshLiveTeamsJournalRaw dshLiveTeamsJournalRawMessage">{entry.detail}</pre>
                    : <div className="dshLiveTeamsJournalMarkdown"><MarkdownText text={entry.detail} labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('markdownFootnotes') }} /></div>}
                </div>
              )}
            </div>
          )}
        </li>
      )
    })}</ul>}</section>
      {inboxExpanded && <div className="dshLiveTeamsOverlay" role="presentation" onClick={() => setInboxExpanded(false)}>
        <div className="dshLiveTeamsDialog" role="dialog" aria-modal="true" aria-label={t('messagesTitle')} onClick={(event) => event.stopPropagation()}>
          <div className="dshLiveTeamsDialogHead">
            <h3 className="dshLiveTeamsDialogTitle">{t('messagesTitle')}</h3>
            <p className="dshLiveTeamsDialogDescription">{attentionWaiting > 0 ? `${attentionWaiting} ${t('unread')}` : t('inboxEmpty')}</p>
            <button className="dshLiveTeamsDialogClose" type="button" aria-label={t('cancel')} onClick={() => setInboxExpanded(false)}>×</button>
          </div>
          <div className="dshLiveTeamsDialogBody">
          <div className="dshLiveTeamsComposer">
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('messageRecipient')}</span><select value={messageTo} disabled={messageBusy} onChange={(event) => setMessageTo(event.target.value)}><option value="">{t('chooseRecipient')}</option><option value="team">{t('wholeTeam')}</option>{members.map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}</select></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('messageKind')}</span><select value={messageKind} disabled={messageBusy} onChange={(event) => setMessageKind(event.target.value as MessageKind | '')}><option value="">{t('chooseMessageKind')}</option><option value="message">{t('messageKindMessage')} — {t('messageKindMessageHint')}</option><option value="direction">{t('messageKindDirection')} — {t('messageKindDirectionHint')}</option><option value="comment">{t('messageKindComment')} — {t('messageKindCommentHint')}</option></select></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('messageContent')}</span><textarea value={messageContent} disabled={messageBusy} maxLength={8000} onChange={(event) => setMessageContent(event.target.value)} /></label>
            <Button variant="primary" size="sm" type="button" disabled={messageBusy || messageTo.length === 0 || messageKind === '' || messageContent.trim().length === 0} onClick={sendMessage}>{t('sendMessage')}</Button>
          </div>
          <div className="dshLiveTeamsInbox" aria-live="polite">
            {inboxLoading ? <p className="dshLiveTeamsMessage">{t('loading')}</p> : inbox.length === 0 ? <p className="dshLiveTeamsMessage">{t('inboxEmpty')}</p> : <ul className="dshLiveTeamsInboxList">{inbox.map((message) => <li className="dshLiveTeamsInboxRow" key={message.delivery.id}><div><strong>{message.fromName}</strong><span className="dshLiveTeamsInboxKind">{t(messageKindKeys[message.kind])}</span><p>{message.content}</p></div>{message.delivery.state === 'acknowledged' ? <span className="dshLiveTeamsInboxAcknowledged">{t('acknowledged')}</span> : <Button variant="outline" size="sm" type="button" onClick={() => acknowledgeMessage(message)}>{t('acknowledge')}</Button>}</li>)}</ul>}
          </div>
          </div>
        </div>
      </div>}
         </div>
         <div className="dshLiveTeamsCol dshLiveTeamsMainRight">
      <section className="dshLiveTeamsCard dshLiveTeamsTasks dshLiveTeamsListPanel" aria-labelledby="dsh-live-teams-tasks-title"><div className="dshLiveTeamsCardTitle"><h3 className="dshLiveTeamsCardTitleText" id="dsh-live-teams-tasks-title">{t('tasksTitle')}</h3><div className="dshLiveTeamsTaskControls"><button className="dshLiveTeamsTaskNew" type="button" disabled={draftBusy} onClick={openNewTask}>{t('taskNew')}</button><div className="dshLiveTeamsSegmented dshLiveTeamsTaskFilter" role="group" aria-label={t('taskFilters')}>{(['active', 'waiting', 'archived'] as const).map((filter) => <button className={`dshLiveTeamsSegmentedButton dshLiveTeamsTaskFilterButton${taskFilter === filter ? ' dshLiveTeamsSegmentedButtonActive dshLiveTeamsTaskFilterButtonActive' : ''}`} type="button" key={filter} aria-pressed={taskFilter === filter} onClick={() => setTaskFilter(filter)}>{t(taskFilterKeys[filter])}</button>)}</div>{dispatch === null ? null : <button className={`dshLiveTeamsSegmentedButton dshLiveTeamsDispatchToggle${dispatch.paused ? ' dshLiveTeamsDispatchTogglePaused' : ''}`} type="button" disabled={dispatchBusy} aria-pressed={dispatch.paused} title={dispatch.pausedBy === undefined ? t('dispatchPaused') : `${t('dispatchPaused')} · ${t('dispatchPausedBy')}: ${dispatch.pausedBy}`} onClick={toggleDispatch}>{dispatch.paused ? t('dispatchResume') : t('dispatchPause')}</button>}</div></div>{dispatch?.paused === true && <p className="dshLiveTeamsNotice" role="status">{t('dispatchPaused')}{dispatch.pausedReason === undefined ? '' : ` — ${dispatch.pausedReason}`}</p>}{taskNotice !== null && <p className="dshLiveTeamsNotice" role="status">{taskNotice}</p>}{taskLoading && taskSummaries.length === 0 ? <p className="dshLiveTeamsMessage">{t('loading')}</p> : <ul className="dshLiveTeamsTaskList">{taskSummaries.filter((task) => taskMatchesFilter(task, taskFilter)).map((summary) => { const expanded = taskExpanded === summary.id; const detail = taskDetails[summary.id]; const canDecide = summary.status === 'waiting' || summary.status === 'needs_human'; return <li className="dshLiveTeamsTaskRow" key={summary.id}><button className="dshLiveTeamsTaskSummary" type="button" aria-expanded={expanded} onClick={() => expanded ? setTaskExpanded(null) : loadTaskDetail(summary)}><span className={`dshLiveTeamsTaskDisclosure${expanded ? ' dshLiveTeamsTaskDisclosureOpen' : ''}`} aria-hidden="true"><IconChevronDownOutline14 size={14} /></span><span className="dshLiveTeamsTaskStatus">{taskStatusLabel(summary.status, t)}</span><strong className="dshLiveTeamsTaskTitle">{summary.title}</strong><span className="dshLiveTeamsTaskRoute">{routeWords(summary.route)}</span>{summary.blockedBy === undefined || summary.blockedBy.length === 0 ? null : <span className="dshLiveTeamsTaskBlocked" title={blockerWords(summary.blockedBy, t)}>{t('taskBlocked')}</span>}{(() => { const verdict: DispatchTaskVerdict | undefined = dispatch?.tasks.find((entry) => entry.taskId === summary.id); const key = verdict === undefined ? undefined : DISPATCH_CHIP_KEYS[verdict.reason]; return key === undefined ? null : <span className="dshLiveTeamsTaskQueued" title={verdict?.detail}>{t(key)}</span> })()}{(() => { const verdict: DispatchTaskVerdict | undefined = dispatch?.tasks.find((entry) => entry.taskId === summary.id); return verdict?.stalled === undefined ? null : <span className="dshLiveTeamsTaskIntervened" title={verdict.stalled.detail}>{t('taskStalled')}{t(verdict.stalled.reason === 'unacknowledged' ? 'taskStalledUnacknowledged' : 'taskStalledIdle')}</span> })()}<span className="dshLiveTeamsTaskRound">{summary.round === undefined || summary.roundLimit === undefined ? '—' : `${summary.round}/${summary.roundLimit}`}</span><span className="dshLiveTeamsTaskAge">{taskAge(summary.updatedAt)}</span></button>{expanded && <div className="dshLiveTeamsTaskDetail">{detail === undefined ? <p>{t('loading')}</p> : <><p>{t('taskAssignee')}: {detail.task.assignee ?? summary.assigneeName ?? '—'}</p><h4>{t('taskAttempts')}</h4>{detail.attempts.length === 0 ? <p>{t('taskNoAttempts')}</p> : <ul className="dshLiveTeamsTaskAttempts">{detail.attempts.map((attempt) => <li key={attempt.id}><strong>{attempt.generation}</strong> — {members.find((entry) => entry.memberId === attempt.memberId)?.displayName ?? attempt.memberId}: {t(attemptStatusKeys[attempt.status])}{attempt.humanIntervenedAt === undefined ? null : <span className="dshLiveTeamsTaskIntervened" title={t('attemptHumanIntervened')}>{t('taskIntervened')}</span>}</li>)}</ul>}{summary.blockedBy === undefined || summary.blockedBy.length === 0 ? null : <><h4>{t('taskBlockedBy')}</h4><ul>{summary.blockedBy.map((blocker) => <li key={blocker.id}>{blocker.title} — {taskStatusLabel(blocker.status, t)}</li>)}</ul></>}<h4>{t('taskAcceptance')}</h4><ul>{detail.task.acceptance.map((item) => <li key={item}>{item}</li>)}</ul><h4>{t('taskDocument')}</h4>{detail.documentMissing === true ? <p>{t('taskDocumentMissing')}</p> : <pre>{detail.document || '—'}</pre>}<h4>{t('taskSubmissions')}</h4><ul>{detail.submissions.map((item) => <li key={item.id}><strong>{item.summary}</strong> — {artifactLabel(item.artifact)}{item.scope === undefined ? null : <span className={`dshLiveTeamsSubmissionScope dshLiveTeamsScope${item.scope.state}`} title={scopeTitle(item.scope, t)}>{t(scopeKeys[item.scope.state])}</span>}<ul>{item.checks.map((check) => <li key={`${item.id}-${check.command}`}>{check.status}: {check.command}</li>)}</ul></li>)}</ul><h4>{t('taskReviewRounds')}</h4><ol>{detail.rounds.map((round) => <li key={round.id}><strong>{round.round}: {round.verdict}</strong><ul>{round.findings.map((finding) => <li key={`${round.id}-${finding.problem}`}>{finding.severity}: {finding.problem}</li>)}</ul><ul>{round.evidence.map((check) => <li key={`${round.id}-${check.command}`}>{check.status}: {check.command}</li>)}</ul></li>)}</ol>{(summary.status === 'draft' || summary.status === 'ready') && <div className="dshLiveTeamsTaskActions"><Button variant="outline" size="sm" type="button" disabled={draftBusy} onClick={() => openContract(summary, detail)}>{t('taskEditContract')}</Button></div>}{summary.status !== 'completed' && summary.status !== 'cancelled' && summary.status !== 'failed' && summary.status !== 'draft' && <div className="dshLiveTeamsTaskActions"><Button variant="outline" size="sm" type="button" disabled={draftBusy} onClick={() => { setReleaseReason(''); setReleaseTarget(summary) }}>{t('taskRelease')}</Button></div>}{canDecide && <div className="dshLiveTeamsTaskActions">{detail.documentMissing !== true && <Button variant="primary" size="sm" type="button" onClick={() => { setTaskNote(''); setTaskConfirm({ kind: 'accept', task: summary }) }}>{t('taskAccept')}</Button>}<Button variant="outline" size="sm" type="button" onClick={() => { setTaskInstructions(''); setTaskConfirm({ kind: 'revise', task: summary }) }}>{t('taskRevise')}</Button></div>}</>}</div>}</li> })}</ul>}<Modal open={taskDraft !== null} onClose={() => { if (!draftBusy) setTaskDraft(null) }} title={taskDraft?.editing === undefined ? t('taskNewTitle') : t('taskEditTitle')} closeLabel={t('cancel')} description={t('taskDraftDescription')} footer={<><Button variant="outline" size="sm" type="button" disabled={draftBusy} onClick={() => setTaskDraft(null)}>{t('cancel')}</Button><Button variant="primary" size="sm" type="button" disabled={draftBusy || draftTitle.trim().length === 0 || draftAssignee.length === 0 || lines(draftAcceptance).length === 0 || (draftRoute === 'review' && draftReviewer.length === 0)} onClick={saveDraft}>{t('taskSave')}</Button></>}>
          <div className="dshLiveTeamsModalFields">
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskTitleLabel')}</span><input type="text" value={draftTitle} disabled={draftBusy} onChange={(event) => setDraftTitle(event.target.value)} /></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskKind')}</span><select value={draftKind} disabled={draftBusy || taskDraft?.editing !== undefined} onChange={(event) => setDraftKind(event.target.value)}>{(['implementation', 'research', 'requirements', 'verification', 'repair', 'integration', 'work'] as const).map((kind) => <option key={kind} value={kind}>{t(`taskKind${kind}` as LocaleKey)}</option>)}</select></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskAssignee')}</span><select value={draftAssignee} disabled={draftBusy} onChange={(event) => setDraftAssignee(event.target.value)}><option value="">—</option>{members.map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}</select></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskRoute')}</span><select value={draftRoute} disabled={draftBusy} onChange={(event) => setDraftRoute(event.target.value === 'review' ? 'review' : 'report')}><option value="report">{t('taskRouteReport')}</option><option value="review">{t('taskRouteReview')}</option></select></label>
            {draftRoute === 'review' && <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskReviewer')}</span><select value={draftReviewer} disabled={draftBusy} onChange={(event) => setDraftReviewer(event.target.value)}><option value="">—</option>{members.filter((member) => member.memberId !== draftAssignee).map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}</select></label>}
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskPaths')}</span><input type="text" value={draftPaths} disabled={draftBusy} onChange={(event) => setDraftPaths(event.target.value)} /></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskAcceptanceLabel')}</span><textarea value={draftAcceptance} disabled={draftBusy} onChange={(event) => setDraftAcceptance(event.target.value)} /></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskChecksLabel')}</span><textarea value={draftChecks} disabled={draftBusy} onChange={(event) => setDraftChecks(event.target.value)} /></label>
            <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskBodyLabel')}</span><textarea value={draftBody} disabled={draftBusy} onChange={(event) => setDraftBody(event.target.value)} /></label>
          </div>
        </Modal>
        <Modal open={releaseTarget !== null} onClose={() => { if (!draftBusy) setReleaseTarget(null) }} title={t('taskReleaseTitle')} closeLabel={t('cancel')} description={t('taskReleaseDescription')} footer={<><Button variant="outline" size="sm" type="button" disabled={draftBusy} onClick={() => setReleaseTarget(null)}>{t('cancel')}</Button><Button variant="primary" size="sm" type="button" disabled={draftBusy || releaseReason.trim().length === 0} onClick={releaseAttempt}>{t('taskRelease')}</Button></>}>
          <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskReleaseReason')}</span><textarea value={releaseReason} disabled={draftBusy} onChange={(event) => setReleaseReason(event.target.value)} /></label>
        </Modal>
        <Modal open={taskConfirm !== null} onClose={() => { if (taskBusy === null) setTaskConfirm(null) }} title={taskConfirm?.kind === 'accept' ? t('taskAcceptTitle') : t('taskReviseTitle')} closeLabel={t('cancel')} description={taskConfirm?.kind === 'accept' ? t('taskAcceptDescription') : t('taskReviseDescription')} footer={<><Button variant="outline" size="sm" type="button" onClick={() => setTaskConfirm(null)}>{t('cancel')}</Button><Button variant="primary" size="sm" type="button" disabled={taskConfirm?.kind === 'revise' && taskInstructions.trim().length === 0} onClick={() => { if (taskConfirm !== null) runTaskAction(taskConfirm.kind, taskConfirm.task) }}>{taskConfirm?.kind === 'accept' ? t('taskAccept') : t('taskRevise')}</Button></>}>{taskConfirm?.kind === 'accept' ? <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskAcceptNote')}</span><textarea value={taskNote} onChange={(event) => setTaskNote(event.target.value)} /></label> : <label className="dshLiveTeamsModalField"><span className="dshLiveTeamsFieldLabel">{t('taskReviseInstructions')}</span><textarea value={taskInstructions} onChange={(event) => setTaskInstructions(event.target.value)} /></label>}</Modal></section>
         </div>
       </div>
     </div>
  </section>
  )
}

function Stat(props: { readonly label: string; readonly value: number }): React.ReactElement {
  return <div className="dshLiveTeamsStat"><dt className="dshLiveTeamsStatLabel">{props.label}</dt><dd className="dshLiveTeamsStatValue">{props.value}</dd></div>
}

export default TeamView
