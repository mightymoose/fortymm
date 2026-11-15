import { z } from 'zod'
import { saveRefusal, type BestOf, type Score } from '../../scoring/scoring.ts'

// The score pad's rules, the one place they are written (web-client/
// CLAUDE.md, "Forms"). The pad holds what is typed in each field, as text
// (digits only: the screen drops anything else as it is typed); the schema
// turns it into a score, `[yours, theirs]`, or says why it can't be saved.
// The rules themselves are the scoring rules' (`saveRefusal`, which asks
// `illegalGameReason`): the schema only wraps them, and says so when a field
// is empty.

export const bothScoresMessage = 'Enter both scores to save this game.'

// Where the game sits in its match: the games saved so far (in game order,
// each `[yours, theirs]`), the match's length, and the number of the game
// being scored.
export type ScoringContext = {
  bestOf: BestOf
  games: readonly Score[]
  game: number
}

export function scoreSchema({ bestOf, games, game }: ScoringContext) {
  return z
    .object({ yours: z.string(), theirs: z.string() })
    .superRefine(({ yours, theirs }, context) => {
      // An empty field: "Enter both scores", on each empty one, so focus goes
      // to the first of them.
      if (yours === '' || theirs === '') {
        for (const [path, value] of [
          ['yours', yours],
          ['theirs', theirs],
        ] as const)
          if (value === '')
            context.addIssue({ code: 'custom', path: [path], message: bothScoresMessage })
        return
      }
      // A whole score: the rules' reason it can't be saved as this game, on
      // both fields (the score is wrong, not one side of it).
      const refusal = saveRefusal(games, bestOf, game, [Number(yours), Number(theirs)])
      if (refusal !== null)
        for (const path of ['yours', 'theirs'] as const)
          context.addIssue({ code: 'custom', path: [path], message: refusal.message })
    })
    .transform(({ yours, theirs }): Score => [Number(yours), Number(theirs)])
}

// What the pad holds, and what a save hands on.
export type ScoreValues = z.input<ReturnType<typeof scoreSchema>>

// The pad as it opens: empty for a game not yet saved, its saved score for
// one that is. Anything else is a change that leaving would lose.
export function scoreDefaults(saved: Score | undefined): ScoreValues {
  return saved === undefined
    ? { yours: '', theirs: '' }
    : { yours: String(saved[0]), theirs: String(saved[1]) }
}
