import type { MatchResult, Side } from '../signing/result'
import type { Match } from './demoMatches'
import type { Submitted } from './scratchpad'

export type SignedResultInput = { issuedAt: number; result: MatchResult; side: Side }

// What the submitter's device signs for `submission`: the games the player
// approved, for the player on their side of the match.
export function signedResultOf(match: Match, submission: Submitted): SignedResultInput {
  const side = match.players.findIndex((player) => player.id === submission.by)
  if (side !== 0 && side !== 1) throw new RangeError(`${submission.by} doesn't play ${match.id}`)
  return {
    issuedAt: Math.floor(Date.parse(submission.submittedAt) / 1000),
    result: {
      match: match.uuid,
      bestOf: match.bestOf,
      rated: match.rated,
      players: [match.players[0].id, match.players[1].id],
      games: submission.games,
      ending: 'completed',
      replaces: null,
    },
    side,
  }
}
