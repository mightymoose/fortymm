import type {
  GameScoreInput,
  GameScoreParseResult,
  GameScoreTier,
} from './game-score-schema'

/**
 * Exactly what {@link mapGameScoreValidation} hands the presentational ScorePad:
 * which side(s) to redden, the hard-error line, and the soft "enter both scores"
 * hint. Slots straight into ScorePad's existing `me.invalid` / `opp.invalid`,
 * `scoreError`, and `showBothRequired` props.
 */
export interface GameScoreUiState {
  /** Redden the `me` field. */
  meInvalid: boolean
  /** Redden the `opp` field. */
  oppInvalid: boolean
  /** The hard-error message (malformed digits or an illegal score), or null. */
  scoreError: string | null
  /** Show the softer "enter both scores to save this game" hint. */
  showBothRequired: boolean
}

/**
 * Turn {@link gameScoreSchema}'s parse result into the ScorePad props for one
 * game. Pure — the schema owns the rules (and their precedence: it never emits
 * the soft `both-required` hint alongside a hard error), so this only routes the
 * issues to fields:
 * - `malformed` → redden that side and surface its message as the hard error,
 * - `illegal` → redden both sides and surface the reason as the hard error,
 * - `both-required` → show the soft hint and redden only the empty side(s).
 *
 * The empty-side flag reads the raw `{ me, opp }` (mirroring the live
 * score-entry logic), so only the field the user hasn't filled goes red.
 */
export function mapGameScoreValidation(
  result: GameScoreParseResult,
  { me, opp }: GameScoreInput,
): GameScoreUiState {
  if (result.success) {
    return {
      meInvalid: false,
      oppInvalid: false,
      scoreError: null,
      showBothRequired: false,
    }
  }

  let scoreError: string | null = null
  let malformedMe = false
  let malformedOpp = false
  let illegal = false
  let bothRequired = false

  for (const issue of result.error.issues) {
    // Every issue the schema emits carries a `tier` on `params` (see
    // `gameScoreSchema`), so read it straight — no untagged issue reaches here.
    // Cast through `unknown`: Zod's issue union types `params` as an optional
    // `Record`, but ours is always this tagged shape.
    const tier = (issue as unknown as { params: { tier: GameScoreTier } }).params
      .tier
    if (tier === 'malformed') {
      scoreError = issue.message
      if (issue.path[0] === 'me') malformedMe = true
      if (issue.path[0] === 'opp') malformedOpp = true
    } else if (tier === 'illegal') {
      scoreError = issue.message
      illegal = true
    } else if (tier === 'both-required') {
      bothRequired = true
    }
  }

  return {
    meInvalid: malformedMe || illegal || (bothRequired && me === ''),
    oppInvalid: malformedOpp || illegal || (bothRequired && opp === ''),
    scoreError,
    showBothRequired: bothRequired,
  }
}
