import { screen } from '@testing-library/react'
import { renderScreen } from '../test/render-screen.tsx'
import { DashboardScreen } from './DashboardScreen.tsx'

// The dashboard (DashboardScreen.tsx): how to render it alone, and what a
// person sees on it. The finders work wherever the screen is mounted,
// through its route (src/routes/index.test.tsx) too.
export class DashboardScreenPage {
  render() {
    return renderScreen(<DashboardScreen />)
  }

  heading() {
    return screen.findByRole('heading', { level: 1, name: 'Dashboard' })
  }

  // The "New match" button beside the heading (non-phone widths only in a
  // browser; jsdom applies no breakpoint), a link. Where the layout is
  // mounted too, the bottom bar has a link of the same name: this is the
  // one in no navigation.
  async newMatch() {
    const links = await screen.findAllByRole('link', { name: 'New match' })
    const [link] = links.filter((link) => link.closest('nav') === null)
    if (link === undefined) throw new Error('The dashboard has no New match')
    return link
  }
}
