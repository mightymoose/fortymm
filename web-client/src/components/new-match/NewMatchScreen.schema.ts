import { z } from 'zod'
import { bestOfs } from '../../scoring/scoring.ts'

// The new match form's rules, the one place they are written
// (web-client/CLAUDE.md, "Forms"). Its input is what the form holds; its
// output is what Start match hands on. Every length a match can be is the
// scoring rules' (`bestOfs`).

// The opponent's name: what was typed, trimmed, or `null` when that leaves
// nothing (a match recorded with no opponent). The screen also asks it
// whether what is typed so far is a name, `null` or not (rated needs one).
export const opponentNameSchema: z.ZodType<string | null, string> = z
  .string()
  .trim()
  .transform((name) => (name === '' ? null : name))

export const newMatchSchema = z
  .object({
    opponentName: opponentNameSchema,
    bestOf: z.literal(bestOfs),
    rated: z.boolean(),
  })
  // Only a match with an opponent can be rated. The screen never gets here
  // (rated is off and disabled with no name); this is the rule itself.
  .refine(({ opponentName, rated }) => !(rated && opponentName === null), {
    path: ['opponentName'],
    message: 'Enter your opponent’s name to rate this match.',
  })
  // The match's format, as the plan's match descriptor names it (`format:
  // {bestOf}`).
  .transform(({ opponentName, bestOf, rated }) => ({
    opponentName,
    format: { bestOf },
    rated,
  }))

// What the form holds, and what it gives its handler.
export type NewMatchValues = z.input<typeof newMatchSchema>
export type NewMatch = z.output<typeof newMatchSchema>

// The form as it opens. Anything else is a change that leaving would lose.
export const newMatchDefaults: NewMatchValues = {
  opponentName: '',
  bestOf: 5,
  rated: false,
}
