import { describe, expect, it } from 'vitest'
import { memberNameFromTitle } from './member-name.js'

describe('memberNameFromTitle', () => {
  it('strips the team suffix the server appends', () => {
    expect(memberNameFromTitle('Builder - B1 Check', 'B1 Check')).toBe('Builder')
  })

  it('strips a suffix that has already compounded', () => {
    expect(memberNameFromTitle('Builder-2 - B1 Check - B1 Check', 'B1 Check')).toBe('Builder-2')
  })

  it('leaves a title alone when the team name is unknown or absent', () => {
    expect(memberNameFromTitle('Builder - B1 Check', undefined)).toBe('Builder - B1 Check')
    expect(memberNameFromTitle('Builder - B1 Check', '   ')).toBe('Builder - B1 Check')
  })

  it('leaves a title that never carried the suffix alone', () => {
    expect(memberNameFromTitle('Builder', 'B1 Check')).toBe('Builder')
    expect(memberNameFromTitle('B1 Check', 'B1 Check')).toBe('B1 Check')
  })

  it('reports no name for a missing title', () => {
    expect(memberNameFromTitle(null, 'B1 Check')).toBe('')
    expect(memberNameFromTitle(undefined, 'B1 Check')).toBe('')
    expect(memberNameFromTitle('   ', 'B1 Check')).toBe('')
  })
})
