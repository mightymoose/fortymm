import { illegalScoreReason } from '@/lib/scoring'

/**
 * The validation verdict for one game's two raw score-input strings, shared by
 * every surface that edits a single game's score (the scratchpad save and the
 * propose-a-result correction flow). Mirrors `validate_game_score` server-side
 * and the inline messaging the scratchpad entry has always shown.
 */
export interface GameScoreValidation {
  /** Both sides parse to a legal, decided final score — safe to submit. */
  valid: boolean
  /** Exactly one side is filled: the other is required before submitting. The
   * untouched (wholly empty) pair is not flagged — that's the initial state. */
  oneSideFilled: boolean
  /** A hard error to surface (malformed digits, or an illegal final score), or
   * null when there's nothing to say yet. */
  error: string | null
  /** The `me` field holds malformed text (not 1–3 digits). */
  meMalformed: boolean
  /** The `opp` field holds malformed text (not 1–3 digits). */
  oppMalformed: boolean
}

/**
 * Validate one game's two raw input strings (taken verbatim — see the #624
 * no-coercion note in the scratchpad entry). A side is well-formed only as 1–3
 * digits; both filled and well-formed are then run through the shared
 * `illegalScoreReason` table-tennis rule.
 */
export function validateGameScore(me: string, opp: string): GameScoreValidation {
  const bothFilled = me !== '' && opp !== ''
  const oneSideFilled = (me !== '') !== (opp !== '')
  const meMalformed = me !== '' && !/^\d{1,3}$/.test(me)
  const oppMalformed = opp !== '' && !/^\d{1,3}$/.test(opp)
  const formatError =
    meMalformed || oppMalformed
      ? 'Enter each score as a whole number from 0 to 999.'
      : null
  const error =
    formatError ??
    (bothFilled ? illegalScoreReason(Number(me), Number(opp)) : null)
  return {
    valid: bothFilled && error === null,
    oneSideFilled,
    error,
    meMalformed,
    oppMalformed,
  }
}

/**
 * Whether a typed string is acceptable to keep in a score field. We only block
 * characters that can't begin a score (letters, sign); digits and a `.` are
 * kept verbatim so a malformed entry stays visible and gets flagged inline
 * rather than masquerading as a real score (#624).
 */
export function isAcceptableScoreInput(value: string): boolean {
  return !/[^\d.]/.test(value)
}
