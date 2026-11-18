import { screen } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
import { MatchUnavailableScreen } from './MatchUnavailableScreen.tsx'

// A match the device wouldn't read (MatchUnavailableScreen.tsx): how to
// render it alone, and what a person sees on it. The finders work wherever
// the screen is mounted, through the match's routes too.
export class MatchUnavailableScreenPage {
  render(props: Parameters<typeof MatchUnavailableScreen>[0]) {
    return renderScreen(<MatchUnavailableScreen {...props} />, { path: '/matches/m' })
  }

  heading() {
    return screen.findByRole('heading', { level: 1, name: 'Couldn’t load this match' })
  }

  alert() {
    return screen.findByRole('alert', { name: 'Couldn’t load this match' })
  }

  alertNow() {
    return screen.queryByRole('alert', { name: 'Couldn’t load this match' })
  }

  tryAgain() {
    return screen.findByRole('button', { name: 'Try again' })
  }

  allMatches() {
    return screen.findByRole('link', { name: 'All matches' })
  }
}
