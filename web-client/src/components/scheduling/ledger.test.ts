import { describe, expect, it } from 'vitest'

import {
  FAILURE_HEADLINE,
  fmtFixtureCounts,
  hasFailureDetail,
  solveChip,
} from './ledger'

describe('solveChip', () => {
  it('gives every status a designed label and tone — never the wire word', () => {
    expect(solveChip('queued', null)).toEqual({
      label: 'Queued',
      tone: 'muted',
      verdict: null,
    })
    expect(solveChip('running', null)).toEqual({
      label: 'Solving',
      tone: 'accent',
      verdict: null,
    })
    expect(solveChip('infeasible', 'infeasible')).toEqual({
      label: "Doesn't fit",
      tone: 'warn',
      verdict: null,
    })
    expect(solveChip('failed', null)).toEqual({
      label: 'Failed',
      tone: 'loss',
      verdict: null,
    })
  })

  it("speaks a succeeded run's verdict in the strip's own words", () => {
    expect(solveChip('succeeded', 'optimal')).toEqual({
      label: 'Solved',
      tone: 'ok',
      verdict: 'Best possible plan',
    })
    expect(solveChip('succeeded', 'feasible').verdict).toBe(
      'Good plan, found under the time cap',
    )
  })

  it('degrades a succeeded run with no verdict to the modest claim, like the strip', () => {
    expect(solveChip('succeeded', null).verdict).toBe(
      'Good plan, found under the time cap',
    )
  })
})

describe('hasFailureDetail', () => {
  it('expands exactly the two terminal not-a-plan outcomes', () => {
    expect(hasFailureDetail('failed')).toBe(true)
    expect(hasFailureDetail('infeasible')).toBe(true)
    expect(hasFailureDetail('succeeded')).toBe(false)
    expect(hasFailureDetail('queued')).toBe(false)
    expect(hasFailureDetail('running')).toBe(false)
  })

  it('has a designed headline for each expandable state', () => {
    expect(FAILURE_HEADLINE.failed).toBe('The scheduler hit a problem')
    expect(FAILURE_HEADLINE.infeasible).toBe("The day doesn't fit")
  })
})

describe('fmtFixtureCounts', () => {
  it('names both counts when the apply wrote them', () => {
    expect(fmtFixtureCounts(9, 2)).toBe('9 placed · 2 pinned')
    expect(fmtFixtureCounts(0, 0)).toBe('0 placed · 0 pinned')
  })

  it('renders nothing for a stage not reached — the caller shows the em-dash', () => {
    expect(fmtFixtureCounts(null, null)).toBeNull()
    expect(fmtFixtureCounts(9, null)).toBeNull()
    expect(fmtFixtureCounts(null, 2)).toBeNull()
  })
})
