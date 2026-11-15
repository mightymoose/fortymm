import { z } from 'zod'
import { saveRefusal, type BestOf, type Games, type Score } from '../../scoring/scoring.ts'

// The score pad's rules, the one place they are written (web-client/
// CLAUDE.md, "Forms"). The pad holds what is typed in each field, as text
// (digits only: the screen drops anything else as it is typed); the schema
// turns it into a score, `[yours, theirs]`, or says why it can't be saved.
// The rules themselves are the scoring rules' (`saveRefusal`, which asks
// `illegalGameReason`): the schema only wraps them, and says so when a field
// is empty.

export const bothScoresMessage = 'Enter both scores to save this game.'

// Where a whole score's refusal goes: the form's, not a field's.
export const refusalPath = 'root'

// The refusal of what the pad holds, if a whole score is refused (none for
// a legal score, or while a field is empty).
export function refusalOf(
  schema: ReturnType<typeof scoreSchema>,
  values: ScoreValues,
): string | undefined {
  return schema
    .safeParse(values)
    .error?.issues.find(({ path }) => path[0] === refusalPath)?.message
}

// Where the game sits in its match: its games (one slot per game number,
// each `[yours, theirs]`), the match's length, and the number of the game
// being scored.
export type ScoringContext = {
  bestOf: BestOf
  games: Games
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
      // A whole score: the rules' reason it can't be saved as this game, once,
      // on the pair rather than on either field (the score is wrong, not one
      // side of it). Path `root`: zodResolver puts it in React Hook Form's
      // `errors.root` (an empty path would be `errors['']`).
      const refusal = saveRefusal(games, bestOf, game, [Number(yours), Number(theirs)])
      if (refusal !== null)
        context.addIssue({ code: 'custom', path: [refusalPath], message: refusal.message })
    })
    .transform(({ yours, theirs }): Score => [Number(yours), Number(theirs)])
}

// What the pad holds, and what a save hands on.
export type ScoreValues = z.input<ReturnType<typeof scoreSchema>>

// The pad as it opens: empty for a game not yet saved, its saved score for
// one that is. Anything else is a change that leaving would lose.
export function scoreDefaults(saved: Score | null): ScoreValues {
  return saved === null
    ? { yours: '', theirs: '' }
    : { yours: String(saved[0]), theirs: String(saved[1]) }
}
