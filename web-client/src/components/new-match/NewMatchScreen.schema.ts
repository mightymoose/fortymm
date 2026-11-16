import { z } from 'zod'
import { bestOfs } from '../../scoring/scoring.ts'

// The new match form's rules, the one place they are written
// (web-client/CLAUDE.md, "Forms"). Its input is what the form holds; its
// output is what Start match hands on. Every length a match can be is the
// scoring rules' (`bestOfs`).
//
// The form asks only the match's length. No match is rated for now: a
// rating needs an opponent who is a real player and signs the result, so
// every match the form makes is unrated.
export const newMatchSchema = z
  .object({
    bestOf: z.literal(bestOfs),
  })
  // The match's format, as the plan's match descriptor names it (`format:
  // {bestOf}`), and whether it is rated: never, for now.
  .transform(({ bestOf }) => ({
    format: { bestOf },
    rated: false,
  }))

// What the form holds, and what it gives its handler.
export type NewMatchValues = z.input<typeof newMatchSchema>
export type NewMatch = z.output<typeof newMatchSchema>

// The form as it opens. Anything else is a change that leaving would lose.
export const newMatchDefaults: NewMatchValues = {
  bestOf: 5,
}
