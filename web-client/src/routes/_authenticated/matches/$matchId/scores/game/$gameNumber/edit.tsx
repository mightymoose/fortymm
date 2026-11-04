import { createFileRoute, redirect } from '@tanstack/react-router'
import { sessionQuery } from '../../../../../../../api/queries'
import { ScoreGame } from '../../../../../../../pages/scoring/ScoreGame'
import { matchOf, scoringMatch } from '../../../../../../../scoring/matches'
import { gamesOf, readFragment } from '../../../../../../../scoring/fragment'

const PATH = '/matches/$matchId/scores/game/$gameNumber/edit'

// The fragment is the match's scores. A fragment the route can't read is
// dropped, with a note in the history state for the page. A game can't
// open before the one ahead of it, so a later or invalid game number goes
// to the first game with no score. The page works out the players from
// the session itself, because a saved account can stand in for the session
// until the API answers with another player.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/game/$gameNumber/edit')({
  // A save changes only the hash, which keeps the same match, so the loader
  // must run again, and before the page renders.
  shouldReload: true,
  loader: {
    staleReloadMode: 'blocking',
    handler: async ({ context: { api, queryClient }, params, location }) => {
      const account = await queryClient.ensureQueryData(sessionQuery(api))
      const scoring = scoringMatch(params.matchId, location.hash)
      const match = matchOf(scoring, { id: account.player.id, name: account.player.display_name }, null)
      const fragment = readFragment(location.hash, match)
      if (!fragment) {
        throw redirect({
          to: PATH,
          params: { matchId: params.matchId, gameNumber: '1' },
          search: true,
          hash: '',
          state: { discardedScores: true },
          replace: true,
        })
      }
      const last = Math.min(gamesOf(fragment).length + 1, match.bestOf)
      const gameNumber = Number(params.gameNumber)
      if (!/^[1-9][0-9]*$/.test(params.gameNumber) || gameNumber > last) {
        throw redirect({
          to: PATH,
          params: { matchId: params.matchId, gameNumber: String(last) },
          search: true,
          hash: location.hash,
          replace: true,
        })
      }
      return { scoring, fragment, gameNumber, last }
    },
  },
  component: ScoreGame,
})
