/**
 * Session titles follow membership.
 *
 * A member's Session is titled `<member name> - <team name>` so the human can
 * find it by name in the session list. Two properties are deliberate and are
 * pinned by tests:
 *
 * - a Session whose title already matches is left alone, so repeated operations
 *   produce no rename and no audit noise;
 * - a title is a convenience, never a precondition. The only capability this
 *   module is given is `rename`, so it cannot prompt, resume or deliver, and a
 *   failure is reported instead of failing the membership operation.
 */

export type SessionTitleReason = 'member-added' | 'member-renamed'

export type SessionTitleResult = {
  readonly from: string | null
  readonly to: string
  readonly reason: SessionTitleReason
  readonly renamed: boolean
}

export type SessionTitleDependencies = {
  rename: (sessionId: string, title: string) => Promise<unknown>
  warn?: (message: string) => void
}

/** The one place the title format is defined. */
export function sessionTitleFor(displayName: string, teamName: string): string {
  return `${displayName} - ${teamName}`
}

/**
 * Bring one Session's title in line with its membership.
 *
 * @returns the outcome, or `undefined` when the title could not be set — the
 *   caller must treat that as a reported inconvenience, not as a failure.
 */
export async function applySessionTitle(
  dependencies: SessionTitleDependencies,
  request: {
    sessionId: string
    displayName: string
    teamName: string
    reason: SessionTitleReason
    previousTitle?: string
  },
): Promise<SessionTitleResult | undefined> {
  const to = sessionTitleFor(request.displayName, request.teamName)
  const from = request.previousTitle ?? null
  if (request.previousTitle === to) return { from, to, reason: request.reason, renamed: false }
  try {
    await dependencies.rename(request.sessionId, to)
    return { from, to, reason: request.reason, renamed: true }
  } catch (error) {
    dependencies.warn?.(`live-teams: could not title Session "${request.sessionId}": ${String(error)}`)
    return undefined
  }
}
