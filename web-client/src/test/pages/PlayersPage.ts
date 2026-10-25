import { screen, within } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the players mockups in unit tests: the index at
// /players, each mockup's list and its player page. Elements are looked up
// through `screen` on every access.
export class PlayersPage {
  static async render(path: string): Promise<PlayersPage> {
    await renderRoute(path)
    return new PlayersPage()
  }

  // A link to a player whose accessible name includes `name`. Some lists
  // name the link with the avatar's initials and the rating too.
  findPlayerLinks(name: string): Promise<HTMLElement[]> {
    return screen.findAllByRole('link', { name: new RegExp(name) })
  }

  queryPlayerLinks(name: string): HTMLElement[] {
    return screen.queryAllByRole('link', { name: new RegExp(name) })
  }

  findHeading(name: string | RegExp): Promise<HTMLElement> {
    return screen.findByRole('heading', { name })
  }

  findText(text: string | RegExp): Promise<HTMLElement> {
    return screen.findByText(text)
  }

  findAlert(): Promise<HTMLElement> {
    return screen.findByRole('alert')
  }

  // The status a skeleton reads to screen readers, such as "Loading
  // players", or null when nothing is loading.
  get loading(): HTMLElement | null {
    return screen.queryByText(/^Loading/, { selector: '[role=status]' })
  }

  // The status of one skeleton, such as "Loading player", where a page has
  // more than one.
  findLoading(label: string): Promise<HTMLElement> {
    return screen.findByText(label, { selector: '[role=status]' })
  }

  // The bar's link to one state of the mockup, such as "Error".
  stateLink(name: string): HTMLElement {
    return within(screen.getByRole('navigation', { name: 'Mockup states' })).getByRole('link', {
      name,
    })
  }

  get mockupLinks(): HTMLElement[] {
    return within(screen.getByRole('list')).getAllByRole('link')
  }

  get sidebarLink(): HTMLElement {
    return within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: 'Players',
    })
  }

  get leagueSelect(): HTMLElement {
    return screen.getByRole('combobox', { name: 'League' })
  }

  get searchBox(): HTMLElement {
    return screen.getByRole('searchbox', { name: 'Search players' })
  }

  button(name: string): HTMLElement {
    return screen.getByRole('button', { name })
  }

  tab(name: string): HTMLElement {
    return screen.getByRole('tab', { name })
  }
}
