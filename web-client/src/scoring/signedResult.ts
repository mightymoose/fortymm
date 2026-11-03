import { queryOptions } from '@tanstack/react-query'
import { NoSigningKey } from '../api/errors'
import { signWithDeviceKey } from '../signing/deviceKey'
import { signResult } from '../signing/envelope'
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

// The envelope this device signs for `submission`. Signing needs no network,
// so the query never pauses offline. It keeps the bytes for the page load,
// because ECDSA here is randomized, and signing again would give other
// signature bytes for the same payload.
export function signedResultQuery(match: Match, submission: Submitted) {
  return queryOptions({
    queryKey: ['signed-result', match.id, submission.submittedAt],
    staleTime: Infinity,
    gcTime: Infinity,
    networkMode: 'always',
    queryFn: async () => {
      const signer = await signWithDeviceKey()
      if (!signer) throw new NoSigningKey()
      const { issuedAt, result, side } = signedResultOf(match, submission)
      return signResult(signer, issuedAt, result, side)
    },
  })
}
