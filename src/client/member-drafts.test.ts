import { describe, expect, it } from 'vitest'
import type { TeamMember } from './api.js'
import { reconcileMemberDrafts } from './member-drafts.js'
const member: TeamMember = { memberId: 'm1', displayName: 'Builder', role: 'builder', availability: 'available', sessionId: 's1', live: true, status: 'running', bindingGeneration: 1, contractRevision: 1 }
describe('member settings draft reconciliation', () => {
  it('preserves the object and draft when only observed state, contacts or revision change', () => {
    const drafts = { m1: 'oracle' }
    expect(reconcileMemberDrafts([member], [{ ...member, status: 'idle', permittedContacts: ['human'], contractRevision: 2 }], drafts, 'role')).toBe(drafts)
    expect(reconcileMemberDrafts([member], [{ ...member, status: 'idle' }], { m1: 'New name' }, 'displayName')).toEqual({ m1: 'New name' })
  })
  it('refreshes an externally changed committed field rather than retaining its stale draft', () => {
    expect(reconcileMemberDrafts([member], [{ ...member, role: 'reviewer' }], { m1: 'oracle' }, 'role')).toEqual({ m1: 'reviewer' })
    expect(reconcileMemberDrafts([member], [{ ...member, displayName: 'Renamed elsewhere' }], { m1: 'Draft name' }, 'displayName')).toEqual({ m1: 'Renamed elsewhere' })
  })
  it('initializes new members and prunes removed member drafts', () => {
    expect(reconcileMemberDrafts([member], [{ ...member, memberId: 'm2' }], { m1: 'oracle' }, 'role')).toEqual({ m2: 'builder' })
  })
  it('does not reuse a previous scope draft when the caller passes no same-team predecessor', () => {
    expect(reconcileMemberDrafts([], [member], { m1: 'oracle' }, 'role')).toEqual({ m1: 'builder' })
  })
})
