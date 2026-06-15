import { useRef, useState } from 'react'

import type { Player } from '@/api/matches'
import {
  mockPlayerSearchEndpoint,
  type PlayerSearchResolver,
} from '@/mocks/endpoints/players/player-search.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import { OpponentTypeahead } from './opponent-typeahead'
import { opponentOptionPage } from './opponent-typeahead/opponent-option.page'

interface HarnessProps {
  initialQuery?: string
  autoFocus?: boolean
  onPick?: (player: Player) => void
}

const scoped = (container: Container) => ({
  /** The combobox `<input>`. */
  getCombobox() {
    return container.getByRole('combobox')
  },
  /** The listbox, present only when there are results to show. */
  queryListbox() {
    return container.queryByRole('listbox')
  },
  /** The id the combobox currently points `aria-activedescendant` at (or null). */
  activeDescendantId() {
    return container.getByRole('combobox').getAttribute('aria-activedescendant')
  },
  /** All option rows currently rendered. */
  getOptions() {
    return container.queryAllByRole('option')
  },
  findOption(name: string | RegExp) {
    return container.findByRole('option', { name })
  },
  /** The "Clear search" affordance, shown only when the input has text. */
  queryClearButton() {
    return container.queryByRole('button', { name: /clear search/i })
  },
  /** Status / hint copy inside the dropdown. */
  queryByText(text: string | RegExp) {
    return container.queryByText(text)
  },
  findByText(text: string | RegExp) {
    return container.findByText(text)
  },
  ...opponentOptionPage.within(container),
})

/**
 * Test page-object for `OpponentTypeahead`. Wraps it in a stateful harness so
 * typing updates the lifted query, and stubs `GET /v1/players/search`. Covers
 * the combobox/listbox roles, keyboard navigation, and Escape behavior.
 */
export const opponentTypeaheadPage = {
  /** Stub `GET /v1/players/search`. */
  mockSearch(resolver: PlayerSearchResolver) {
    mockPlayerSearchEndpoint(server, resolver)
  },

  render({ initialQuery = '', autoFocus = false, onPick = () => {} }: HarnessProps = {}) {
    // Local component (not module-level) so this page-object file still exports
    // only the page object, keeping fast-refresh happy. Mirrors how
    // `OpponentPicker` owns the lifted `query` / `focusOnMountRef`.
    const TypeaheadHarness = () => {
      const [query, setQuery] = useState(initialQuery)
      const focusOnMountRef = useRef(autoFocus)
      return (
        <OpponentTypeahead
          query={query}
          onQueryChange={setQuery}
          onPick={onPick}
          focusOnMountRef={focusOnMountRef}
        />
      )
    }
    render(<TypeaheadHarness />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
