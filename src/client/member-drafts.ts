import type { TeamMember } from './api.js'

/** Presentation-only reconciliation: status/contact refreshes must not overwrite unsaved inputs. */
export function reconcileMemberDrafts(previous: readonly TeamMember[], next: readonly TeamMember[], drafts: Record<string, string>, field: 'role' | 'displayName'): Record<string, string> {
  const old = new Map(previous.map(member => [member.memberId, member]))
  const result: Record<string, string> = {}
  for (const member of next) result[member.memberId] = old.get(member.memberId)?.[field] === member[field] ? drafts[member.memberId] ?? member[field] : member[field]
  return Object.keys(result).length === Object.keys(drafts).length && Object.entries(result).every(([key, value]) => drafts[key] === value) ? drafts : result
}
