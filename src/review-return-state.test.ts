import { describe, expect, it } from 'vitest'
import { parseReviewReturn } from './review-return-state.js'

const pending = { roundId: 'r1', submissionId: 'sub1', attemptId: 'a1', generation: 1, assignee: 'worker', sessionId: 's1', bindingGeneration: 0, at: 1, state: 'pending' }
describe('portable review return metadata', () => {
  it('accepts legacy binding generation zero and strips arbitrary body/source fields from projections', () => {
    expect(parseReviewReturn({ ...pending, body: 'private body', source: { conversation: 'not a receipt' } })).toEqual(pending)
  })
  it.each([{ generation: 0 }, { bindingGeneration: -1 }, { state: 'invented' }, { leadNotified: 'yes' }, { roundId: '' }, { messageId: 'm1' }, { state: 'started', messageId: 'm1', requestId: 'req1' }, { state: 'completed' }, { at: NaN }])('refuses malformed metadata %j', patch => {
    expect(() => parseReviewReturn({ ...pending, ...patch })).toThrow()
  })
  it('requires operational receipt metadata for confirmed execution', () => {
    expect(parseReviewReturn({ ...pending, state: 'started', messageId: 'm1', requestId: 'req1', turn: 1, inputSeq: 2 })).toMatchObject({ state: 'started', turn: 1, inputSeq: 2 })
  })
})
