import { z } from 'zod'

import { illegalScoreReason } from '@/lib/scoring'

/**
 * The message shown when a filled side isn't a plain 1–2-digit whole number.
 * Mirrors the live `validateGameScore` copy (the server caps each side at 99).
 */
export const MALFORMED_SCORE_MESSAGE =
  'Enter each score as a whole number from 0 to 99.'

/**
 * The soft hint shown when the game is only half-entered (one side filled, or
 * both still empty). Lower severity than a hard error — matches the ScorePad
 * `showBothRequired` line.
 */
export const BOTH_REQUIRED_MESSAGE = 'Enter both scores to save this game.'

/**
 * How a single game's two raw inputs failed, carried on each issue's `params`
 * so the issues→UI mapper can render the three message tiers without re-parsing
 * the strings:
 * - `malformed` — a filled side that isn't 1–2 digits (hard error, that side).
 * - `illegal` — both sides well-formed but the final score breaks the
 *   table-tennis rule (hard error, cross-field / both sides).
 * - `both-required` — a side is still empty (soft hint, the empty side only).
 */
export type GameScoreTier = 'malformed' | 'illegal' | 'both-required'

/** One filled score side is well-formed only as 1–2 digits (server caps at 99). */
const SCORE_DIGITS = /^\d{1,2}$/

/**
 * One game's two raw score-input strings, taken verbatim — no coercion or trim,
 * so a malformed entry stays visible and gets flagged rather than laundered into
 * a real score (#624).
 *
 * Validation runs on submit (the button is never disabled, ADR-0018), producing
 * issues the mapper renders as ScorePad's existing three tiers. Precedence
 * mirrors the live `validateGameScore`: a malformed side or an illegal final
 * score (both hard) short-circuits before the softer "enter both scores" hint,
 * so a half-entered game with a malformed side reports the malformed error, not
 * the hint.
 *
 * The tier lives on each issue's `params` (see {@link GameScoreTier}); the path
 * points at the side(s) to redden — a malformed side's own path, the empty
 * side's path for the soft hint, and the root (`[]`) for an illegal score,
 * which reddens both sides.
 */
export const gameScoreSchema = z
  .object({
    me: z.string(),
    opp: z.string(),
  })
  .superRefine(({ me, opp }, ctx) => {
    const meFilled = me !== ''
    const oppFilled = opp !== ''
    const meMalformed = meFilled && !SCORE_DIGITS.test(me)
    const oppMalformed = oppFilled && !SCORE_DIGITS.test(opp)

    // Hard tier 1: a malformed digit run on a filled side outranks everything
    // else — flag each offending side and stop.
    if (meMalformed || oppMalformed) {
      if (meMalformed) {
        ctx.addIssue({
          code: 'custom',
          path: ['me'],
          message: MALFORMED_SCORE_MESSAGE,
          params: { tier: 'malformed' },
        })
      }
      if (oppMalformed) {
        ctx.addIssue({
          code: 'custom',
          path: ['opp'],
          message: MALFORMED_SCORE_MESSAGE,
          params: { tier: 'malformed' },
        })
      }
      return
    }

    // Hard tier 2: both sides well-formed but the decided score is illegal. The
    // whole game is wrong, so this is a cross-field issue on the root path — the
    // UI reddens both sides.
    if (meFilled && oppFilled) {
      const reason = illegalScoreReason(Number(me), Number(opp))
      if (reason !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [],
          message: reason,
          params: { tier: 'illegal' },
        })
      }
      return
    }

    // Soft tier: the game is only half-entered — a hint on each empty side. A
    // wholly-empty pair lands here too (both sides flagged), because the submit
    // button is always enabled and an empty submit must say "enter both scores".
    if (!meFilled) {
      ctx.addIssue({
        code: 'custom',
        path: ['me'],
        message: BOTH_REQUIRED_MESSAGE,
        params: { tier: 'both-required' },
      })
    }
    if (!oppFilled) {
      ctx.addIssue({
        code: 'custom',
        path: ['opp'],
        message: BOTH_REQUIRED_MESSAGE,
        params: { tier: 'both-required' },
      })
    }
  })

/** One game's two raw score strings — `{ me, opp }`, taken verbatim. */
export type GameScoreInput = z.infer<typeof gameScoreSchema>

/** The `safeParse` result shape for {@link gameScoreSchema}. */
export type GameScoreParseResult = ReturnType<typeof gameScoreSchema.safeParse>
