import { describe, expect, it } from 'vitest'

import {
  OUTCOME_HEADLINE,
  fmtFixtureCounts,
  hasOutcomeDetail,
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

  it('gives a timed-out run its OWN label and the warn tone — not the crash chip', () => {
    // A run that proved nothing is not a run that broke (ADR "a time-capped
    // solve is its own outcome, not a failure").
    expect(solveChip('timed_out', null)).toEqual({
      label: 'Timed out',
      tone: 'warn',
      verdict: null,
    })
    expect(solveChip('timed_out', null).label).not.toBe(
      solveChip('failed', null).label,
    )
    expect(solveChip('timed_out', null).tone).not.toBe('loss')
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

describe('hasOutcomeDetail', () => {
  it('expands exactly the three terminal not-a-plan outcomes', () => {
    expect(hasOutcomeDetail('failed')).toBe(true)
    expect(hasOutcomeDetail('infeasible')).toBe(true)
    // A timed-out run keeps its expansion: the cap sentence and the drift
    // guard's fingerprint are exactly what an operator opens the row for.
    expect(hasOutcomeDetail('timed_out')).toBe(true)
    expect(hasOutcomeDetail('succeeded')).toBe(false)
    expect(hasOutcomeDetail('queued')).toBe(false)
    expect(hasOutcomeDetail('running')).toBe(false)
  })

  it('has a designed headline for each expandable state — three outcomes, three sentences', () => {
    expect(OUTCOME_HEADLINE.failed).toBe('The scheduler hit a problem')
    expect(OUTCOME_HEADLINE.infeasible).toBe("The day doesn't fit")
    expect(OUTCOME_HEADLINE.timed_out).toBe('The scheduler ran out of time')
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
