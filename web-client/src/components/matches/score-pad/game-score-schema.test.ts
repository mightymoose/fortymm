import { describe, expect, it } from 'vitest'

import {
  BOTH_REQUIRED_MESSAGE,
  MALFORMED_SCORE_MESSAGE,
  gameScoreSchema,
  type GameScoreTier,
} from './game-score-schema'

interface FlatIssue {
  path: (PropertyKey | undefined)[]
  message: string
  tier: GameScoreTier | undefined
}

/** Parse and flatten the issues to the parts the mapper reads (path, message,
 * tier), so each tier can be asserted precisely. */
function issuesFor(me: string, opp: string): FlatIssue[] {
  const result = gameScoreSchema.safeParse({ me, opp })
  if (result.success) return []
  return result.error.issues.map((issue) => ({
    path: [...issue.path],
    message: issue.message,
    tier: (issue as { params?: { tier?: GameScoreTier } }).params?.tier,
  }))
}

describe('gameScoreSchema', () => {
  describe('valid — both sides filled, well-formed, legal decided score', () => {
    it('accepts a legal decided game (11–9) with no issues', () => {
      const result = gameScoreSchema.safeParse({ me: '11', opp: '9' })
      expect(result.success).toBe(true)
    })

    it('accepts a losing-but-legal score (9–11)', () => {
      expect(issuesFor('9', '11')).toEqual([])
    })

    it('accepts a legal deuce game (12–10)', () => {
      expect(issuesFor('12', '10')).toEqual([])
    })

    it('accepts a two-digit zero-loser game (11–0)', () => {
      expect(issuesFor('11', '0')).toEqual([])
    })
  })

  describe('illegal — a cross-field (root) hard error that reddens both sides', () => {
    it('flags a sub-11 winner (8–5) on the root path with the reason', () => {
      expect(issuesFor('8', '5')).toEqual([
        {
          path: [],
          message: 'The winning side must reach at least 11 points.',
          tier: 'illegal',
        },
      ])
    })

    it('flags a tie (11–11) with the tie reason', () => {
      expect(issuesFor('11', '11')).toEqual([
        {
          path: [],
          message: 'A game cannot end in a tie.',
          tier: 'illegal',
        },
      ])
    })
  })

  describe('malformed — a hard error on the offending side only', () => {
    it('flags a trailing-letter run ("1x") on the me path only', () => {
      expect(issuesFor('1x', '7')).toEqual([
        { path: ['me'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })

    it('flags a decimal ("5.") on the me path', () => {
      expect(issuesFor('5.', '7')).toEqual([
        { path: ['me'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })

    it('flags a three-digit run ("111") as malformed (1–2 digits only)', () => {
      expect(issuesFor('111', '7')).toEqual([
        { path: ['me'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })

    it('flags a leading-letter run ("x1") as malformed (anchored regex)', () => {
      expect(issuesFor('x1', '7')).toEqual([
        { path: ['me'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })

    it('flags a malformed opp side on the opp path only', () => {
      expect(issuesFor('7', '1x')).toEqual([
        { path: ['opp'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })

    it('flags both sides when both are malformed', () => {
      expect(issuesFor('1x', '2y')).toEqual([
        { path: ['me'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
        { path: ['opp'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })
  })

  describe('both-required — the soft hint on the empty side(s)', () => {
    it('flags only the empty opp side when me is filled', () => {
      expect(issuesFor('11', '')).toEqual([
        { path: ['opp'], message: BOTH_REQUIRED_MESSAGE, tier: 'both-required' },
      ])
    })

    it('flags only the empty me side when opp is filled', () => {
      expect(issuesFor('', '11')).toEqual([
        { path: ['me'], message: BOTH_REQUIRED_MESSAGE, tier: 'both-required' },
      ])
    })

    it('flags both sides for a wholly-empty pair', () => {
      expect(issuesFor('', '')).toEqual([
        { path: ['me'], message: BOTH_REQUIRED_MESSAGE, tier: 'both-required' },
        { path: ['opp'], message: BOTH_REQUIRED_MESSAGE, tier: 'both-required' },
      ])
    })
  })

  describe('precedence — hard errors outrank the both-required hint', () => {
    it('reports only the malformed error when a malformed side sits beside an empty one', () => {
      expect(issuesFor('1x', '')).toEqual([
        { path: ['me'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })

    it('reports only the malformed error, never the illegal one, when the other side is a well-formed score', () => {
      expect(issuesFor('1x', '5')).toEqual([
        { path: ['me'], message: MALFORMED_SCORE_MESSAGE, tier: 'malformed' },
      ])
    })
  })
})
