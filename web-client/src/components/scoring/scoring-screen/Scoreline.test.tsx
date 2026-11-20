import { screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { renderScreen } from '../../../test/render-screen.tsx'
import { Scoreline, type Updates } from './Scoreline.tsx'

// The scoreline alone: how the games that changed elsewhere are read out.
// When they are marked is the scoring screen's (ScoringScreen.tsx), proved
// on the connected page (components/Scoring.test.tsx).

function render(updates: Updates) {
  return renderScreen(
    <Scoreline
      bestOf={5}
      games={[[11, 7]]}
      game={2}
      gameLink={(n) => ({
        to: '/matches/$matchId/games/$gameId/scores/edit',
        params: { matchId: 'm', gameId: String(n) },
      })}
      updates={updates}
    />,
  )
}

async function readOut() {
  return within(await screen.findByRole('navigation', { name: 'Scoreline' })).findByRole('status')
}

test.each([
  { games: [1], words: 'Game 1 updated.' },
  { games: [1, 3], words: 'Games 1 and 3 updated.' },
  { games: [1, 3, 4], words: 'Games 1, 3 and 4 updated.' },
])('$words is read out for games $games; the cells are named as ever', async ({ games, words }) => {
  render({ games, change: 1 })

  expect(await readOut()).toHaveTextContent(new RegExp(`^${words.replace('.', '\\.')}$`))
  expect(screen.getByRole('link', { name: 'Game 1, 11–7' })).toBeInTheDocument()
})

test('before any change, the status is there and says nothing', async () => {
  render({ games: [], change: 0 })

  expect(await readOut()).toBeEmptyDOMElement()
})
