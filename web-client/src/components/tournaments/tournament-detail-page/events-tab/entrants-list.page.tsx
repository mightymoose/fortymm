import { render, screen, within, type Container } from '@/test/utilities'

import { EntrantsList, type EntrantsListProps } from './entrants-list'
import { buildEntrantsListProps } from './entrants-list.factory'

/**
 * The designed copy for each of the two "no entrants" states, written out here
 * rather than imported from the component: a test that asserts a constant against
 * itself asserts nothing. An empty container has no copy at all, so these strings
 * are what tell the states apart — from a blank gap, and from each other.
 *
 * `NO_ENTRANTS_COPY` invites you to be the first; `ENTRY_CLOSED_COPY` says the
 * door does not exist. Showing the first on a doubles event would be a lie, so
 * the two are asserted separately and mutually.
 */
export const NO_ENTRANTS_COPY = 'No one has entered yet.'

export const ENTRY_CLOSED_COPY = {
  doubles: "Doubles events can't be entered yet.",
  teams: "Teams events can't be entered yet.",
} as const

/** The tag on the signed-in player's own chip. Spelled out here rather than
 * imported, for the same reason as the copy above. */
export const YOU_TAG = '(you)'

/** The `+N more` tail's shape. Anchored, so `+4 more` cannot satisfy an
 * assertion about `+44 more`. */
const TAIL_PATTERN = /^\+\d+ more$/

const scoped = (container: Container) => {
  /** The roster for `eventName`. A real `list`, named per event because a tab
   * shows many cards at once. Absent when the event has no entrants: that case
   * renders the empty copy instead of an empty list. */
  const getEntrantsList = (eventName: string) =>
    container.getByRole('list', { name: `Entrants in ${eventName}` })

  return {
    getEntrantsList,
    queryEntrantsList(eventName: string) {
      return container.queryByRole('list', { name: `Entrants in ${eventName}` })
    },
    findEntrantsList(eventName: string) {
      return container.findByRole('list', { name: `Entrants in ${eventName}` })
    },
    /** Every row of the roster, in order — the entrants the card actually
     * shows, plus the `+N more` tail when it is truncating. */
    getEntrantItems(eventName: string) {
      return within(getEntrantsList(eventName)).getAllByRole('listitem')
    },
    /** One entrant of `eventName` by username — `null` when they are not listed
     * (withdrawn, never entered, or past the truncation cut-off). */
    queryEntrant(eventName: string, username: string) {
      return within(getEntrantsList(eventName)).queryByText(username)
    },
    findEntrant(eventName: string, username: string) {
      return within(getEntrantsList(eventName)).findByText(username)
    },
    /** The usernames the roster actually SHOWS, in the order it shows them (the
     * `+N more` tail is not one of them). Order is the assertion: the signed-in
     * player's own chip is pinned to the front, and everyone else stays
     * oldest-entry-first behind it. */
    getEntrantNames(eventName: string): string[] {
      return within(getEntrantsList(eventName))
        .getAllByRole('listitem')
        .filter((li) => !TAIL_PATTERN.test(li.textContent ?? ''))
        .map((li) => li.firstElementChild?.textContent ?? li.textContent ?? '')
    },
    /** The `(you)` tag marking the signed-in player's own chip — `null` when the
     * viewer is signed out or is not in this event. */
    queryYouTag(eventName: string) {
      return within(getEntrantsList(eventName)).queryByText(YOU_TAG)
    },
    /** The `+N more` tail shown when the roster is longer than the card lists. */
    queryTruncationTail(eventName: string) {
      return within(getEntrantsList(eventName)).queryByText(TAIL_PATTERN)
    },
    /** Every button in the roster — always none. The list is inert: the card's
     * stretched open target is the only thing here that takes a click. */
    queryAllButtons() {
      return container.queryAllByRole('button')
    },
    /** The designed empty state — the copy itself, not merely the absence of a
     * list, so a blank gap cannot pass for it. (Exact match on purpose: the
     * lead line is its own element, and a substring match would also hit the
     * paragraph wrapping it.) Shown only for a *singles* event nobody has
     * entered — a doubles/teams event gets `queryEntryClosedCopy` instead. */
    queryEmptyCopy() {
      return container.queryByText(NO_ENTRANTS_COPY)
    },
    findEmptyCopy() {
      return container.findByText(NO_ENTRANTS_COPY)
    },
    /** The designed "this format can't be entered" state, for a doubles or teams
     * event. */
    queryEntryClosedCopy(format: keyof typeof ENTRY_CLOSED_COPY) {
      return container.queryByText(ENTRY_CLOSED_COPY[format])
    },
    findEntryClosedCopy(format: keyof typeof ENTRY_CLOSED_COPY) {
      return container.findByText(ENTRY_CLOSED_COPY[format])
    },
  }
}

/** Test page-object for `EntrantsList`. */
export const entrantsListPage = {
  render(overrides: Partial<EntrantsListProps> = {}) {
    render(<EntrantsList {...buildEntrantsListProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
