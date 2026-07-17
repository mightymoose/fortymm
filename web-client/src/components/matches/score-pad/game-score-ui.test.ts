import { describe, expect, it } from 'vitest'

import {
  BOTH_REQUIRED_MESSAGE,
  MALFORMED_SCORE_MESSAGE,
  gameScoreSchema,
  type GameScoreParseResult,
} from './game-score-schema'
import { mapGameScoreValidation, type GameScoreUiState } from './game-score-ui'

/** Parse the raw pair through the schema and map it to ScorePad props — the same
 * two-step 1b wires into the form. */
function uiFor(me: string, opp: string): GameScoreUiState {
  return mapGameScoreValidation(gameScoreSchema.safeParse({ me, opp }))
}

/** A hand-built failed parse result carrying one issue with an arbitrary tier
 * (and optional side path) — to prove the mapper only reacts to the tiers it
 * knows, rather than treating any leftover issue as the soft hint. */
function failedResultWithTier(
  tier: string,
  path: PropertyKey[] = [],
): GameScoreParseResult {
  return {
    success: false,
    error: { issues: [{ code: 'custom', message: 'nope', path, params: { tier } }] },
  } as unknown as GameScoreParseResult
}

describe('mapGameScoreValidation', () => {
  it('reports a clean slate for a legal decided game (11–9)', () => {
    expect(uiFor('11', '9')).toEqual({
      meInvalid: false,
      oppInvalid: false,
      scoreError: null,
      showBothRequired: false,
    })
  })

  it('reports a clean slate for a losing-but-legal score (9–11)', () => {
    expect(uiFor('9', '11')).toEqual({
      meInvalid: false,
      oppInvalid: false,
      scoreError: null,
      showBothRequired: false,
    })
  })

  it('reddens both sides for an illegal finished score (8–5) with the reason', () => {
    expect(uiFor('8', '5')).toEqual({
      meInvalid: true,
      oppInvalid: true,
      scoreError: 'The winning side must reach at least 11 points.',
      showBothRequired: false,
    })
  })

  it('reddens only the me side for a malformed me entry ("1x")', () => {
    expect(uiFor('1x', '7')).toEqual({
      meInvalid: true,
      oppInvalid: false,
      scoreError: MALFORMED_SCORE_MESSAGE,
      showBothRequired: false,
    })
  })

  it('reddens only the opp side for a malformed opp entry ("1x")', () => {
    expect(uiFor('7', '1x')).toEqual({
      meInvalid: false,
      oppInvalid: true,
      scoreError: MALFORMED_SCORE_MESSAGE,
      showBothRequired: false,
    })
  })

  it('reddens both sides when both entries are malformed', () => {
    expect(uiFor('1x', '2y')).toEqual({
      meInvalid: true,
      oppInvalid: true,
      scoreError: MALFORMED_SCORE_MESSAGE,
      showBothRequired: false,
    })
  })

  it('shows the soft hint and reddens only the empty opp side when me is filled', () => {
    expect(uiFor('11', '')).toEqual({
      meInvalid: false,
      oppInvalid: true,
      scoreError: null,
      showBothRequired: true,
    })
  })

  it('shows the soft hint and reddens only the empty me side when opp is filled', () => {
    expect(uiFor('', '11')).toEqual({
      meInvalid: true,
      oppInvalid: false,
      scoreError: null,
      showBothRequired: true,
    })
  })

  it('shows the soft hint and reddens both sides for a wholly-empty pair', () => {
    expect(uiFor('', '')).toEqual({
      meInvalid: true,
      oppInvalid: true,
      scoreError: null,
      showBothRequired: true,
    })
  })

  it('surfaces the malformed error (never the hint) when a malformed side sits beside an empty one', () => {
    expect(uiFor('1x', '')).toEqual({
      meInvalid: true,
      oppInvalid: false,
      scoreError: MALFORMED_SCORE_MESSAGE,
      showBothRequired: false,
    })
  })

  it('ignores an issue whose tier it does not recognize (only both-required raises the hint)', () => {
    expect(mapGameScoreValidation(failedResultWithTier('mystery'))).toEqual({
      meInvalid: false,
      oppInvalid: false,
      scoreError: null,
      showBothRequired: false,
    })
  })

  it('ignores an unrecognized tier even when its issue targets a side path', () => {
    // The `both-required` branch keys off the tier, NOT merely "any leftover
    // issue on a side path": an unknown tier pointed at `['me']` must not redden
    // that side or raise the hint. (Kills the `tier === 'both-required'` → `true`
    // mutant, which would treat this issue as the soft hint.)
    expect(
      mapGameScoreValidation(failedResultWithTier('mystery', ['me'])),
    ).toEqual({
      meInvalid: false,
      oppInvalid: false,
      scoreError: null,
      showBothRequired: false,
    })
  })

  it('does not use the BOTH_REQUIRED copy as a hard error', () => {
    // The soft tier never populates scoreError — that line is the hint, not the
    // red error. Guards against the mapper mis-routing the both-required issue.
    expect(uiFor('11', '').scoreError).not.toBe(BOTH_REQUIRED_MESSAGE)
  })
})
