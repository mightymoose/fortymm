import { z } from 'zod'

// The new match form's rules, the one place they are written
// (web-client/CLAUDE.md, "Forms"). Its input is what the form holds; its
// output is what Start match hands on.

// Every length a match can be, shortest first (BestOfField names each).
export const bestOfs = [1, 3, 5, 7] as const
export type BestOf = (typeof bestOfs)[number]

// The opponent's name: what was typed, trimmed, and not empty. The screen
// also asks it whether what is typed so far is a name (rated needs one).
export const opponentNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your opponent’s name.')

export const newMatchSchema = z
  .object({
    opponentName: opponentNameSchema,
    bestOf: z.literal(bestOfs),
    rated: z.boolean(),
  })
  // The match's format, as the plan's match descriptor names it (`format:
  // {bestOf, points}`); every game is to 11.
  .transform(({ opponentName, bestOf, rated }) => ({
    opponentName,
    format: { bestOf, points: 11 as const },
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
