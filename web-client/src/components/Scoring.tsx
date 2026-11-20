import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useNewVersion } from '../new-version.ts'
import { gameToOpen } from '../scoring/game-to-open.ts'
import { nextGame } from '../scoring/scoring.ts'
import { matchStore, useMatch } from '../stores/match.ts'
import { ScoringScreen } from './scoring/ScoringScreen.tsx'

// The scoring page (/matches/$matchId/games/$gameId/scores/edit), connected
// to the match store (src/stores/match.ts); the match layout (Match.tsx)
// watches the match, and the route's loaders have read it before this mounts.
//
// The page shows the match as the store holds it, live: another tab's write
// (later, a sync pull) shows at once, and the screen says so (the user's
// rule: "we can change things in the background as long as theres some
// notification that it happened"). What is typed stays (ScoringScreen). A
// save is checked against the match as the device keeps it at that moment,
// so one the rules now refuse shows its message on the screen.
//
// A save the store takes moves on the moment it answers (the screen's
// `onSaved`): to the lowest empty game, or to the dashboard once the match
// is decided (an edit that leaves it decided too), replacing this page and
// past the screen's leave guard, since a saved form is still dirty. The
// screen doesn't move on when the person left scoring while the save was on
// its way: they go where they went. A clear (any saved game, at once) stays
// on the page, which then shows that game empty. The store's answer to
// either goes back to the screen, which shows one refused (by the device,
// or by the rules on the match as kept) and goes nowhere. Whether a new
// version is waiting (src/new-version.ts) goes to it too.
//
// The page never renders nothing for a match it can read. The match can
// become readable (a read again, after the device refused the loaders')
// without the route's guard having asked about this game: an empty game of
// a match decided meanwhile shows the screen, which says the match was
// finished; a game the route wouldn't open at all (a number past the best
// of) runs the route's loaders again (`router.invalidate()`), whose guard
// then answers. While a navigation is on its way (the guard's redirect),
// an empty game of a decided match shows nothing for that moment. Try
// again, which runs the loaders while the match can't be read, is the match
// layout's: it shows its own page until they have answered (Match.tsx), so
// this page never shows a form the guard is about to send away from.
export function Scoring({ matchId, game }: { matchId: string; game: number }) {
  const entry = useMatch(matchId)
  const navigate = useNavigate()
  const router = useRouter()
  const newVersion = useNewVersion()
  // Whether the router is loading: a navigation, the guard's redirect among
  // them, is on its way.
  const loading = useRouterState({ select: (state) => state.isLoading })
  const opened = entry?.status === 'ready' ? gameToOpen(String(game), entry.match).status : null
  // Asked once for a game: the loaders' guard answers for good.
  const unopened = opened === 'not-found' ? `${matchId}:${game}` : null
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (unopened === null || asked.current === unopened) return
    asked.current = unopened
    void router.invalidate()
  }, [unopened, router])
  if (entry?.status !== 'ready' || opened === 'not-found') return null
  // An empty game of a decided match while a navigation is on its way (the
  // guard's redirect to the dashboard): nothing, for that moment.
  if (opened === 'decided' && loading) return null
  const { bestOf, games } = entry.match
  // A fresh screen for each match: the router keeps this page mounted when
  // only the match in the URL changes (Back from another match's game), and
  // nothing typed or refused on one match may stay for another.
  return (
    <ScoringScreen
      key={matchId}
      bestOf={bestOf}
      games={games}
      game={game}
      newVersion={newVersion}
      matchPage={{ to: '/matches/$matchId', params: { matchId } }}
      gameLink={(n) => ({
        to: '/matches/$matchId/games/$gameId/scores/edit',
        params: { matchId, gameId: String(n) },
      })}
      onSave={(n, score) => matchStore.getState().setGameScore(matchId, n, score)}
      onSaved={() => {
        const saved = matchStore.getState().matches[matchId]
        if (saved?.status !== 'ready') return
        const next = nextGame(saved.match.games, saved.match.bestOf)
        void navigate(
          next === null
            ? { to: '/', replace: true, ignoreBlocker: true }
            : {
                to: '/matches/$matchId/games/$gameId/scores/edit',
                params: { matchId, gameId: String(next) },
                replace: true,
                ignoreBlocker: true,
              },
        )
      }}
      onClear={(n) => matchStore.getState().clearGameScore(matchId, n)}
    />
  )
}

