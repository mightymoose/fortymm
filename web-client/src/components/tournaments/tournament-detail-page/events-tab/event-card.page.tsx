import { render, screen, type Container } from '@/test/utilities'

import { EventCard, type EventCardProps } from './event-card'
import { buildEventCardProps } from './event-card.factory'
import { drawPanelPage } from './draw-panel.page'
import { entrantsListPage } from './entrants-list.page'

const scoped = (container: Container) => ({
  // The roster the card renders (`EntrantsList`): `getEntrantsList`,
  // `queryEntrant`, `queryEmptyCopy`, `queryTruncationTail`, … all keyed by
  // event name. Spread first, so the card's own accessors below win any name
  // clash.
  ...entrantsListPage.within(container),
  // The draw the card hosts in its `draw` slot (`DrawPanel`): `queryPanel`,
  // `getGroupLines`, `queryGenerateButton`, … The card only wires it in — the panel's
  // own quartet pins its content.
  ...drawPanelPage.within(container),

  /** The full-card open target — labelled `Edit <event>` for an owner, or
   * `View <event>` for a non-owner (read-only). Pass the verb to assert the
   * read-only case. */
  getOpenButton(name: string, verb: 'Edit' | 'View' = 'Edit') {
    return container.getByRole('button', { name: `${verb} ${name}` })
  },
  /** A control the card hosts in its action slot, by accessible name. */
  getActionControl(name: string | RegExp) {
    return container.getByRole('button', { name })
  },
  /** The self-registration control the card hosts (`EnterEventControl`). Named
   * per event (`Enter <event>` / `Withdraw from <event>`) so it stays
   * unambiguous across a list of cards — and distinct from the card's own
   * `Edit`/`View <event>` open target. Absent for an unpermitted player and on
   * non-singles events. */
  findEnterButton(eventName: string) {
    return container.findByRole('button', { name: `Enter ${eventName}` })
  },
  queryEnterButton(eventName: string) {
    return container.queryByRole('button', { name: `Enter ${eventName}` })
  },
  findWithdrawButton(eventName: string) {
    return container.findByRole('button', { name: `Withdraw from ${eventName}` })
  },
  queryWithdrawButton(eventName: string) {
    return container.queryByRole('button', { name: `Withdraw from ${eventName}` })
  },
  /** Every button the card renders — a card hosting no control of its own has
   * exactly one: the stretched open target. */
  queryAllButtons() {
    return container.queryAllByRole('button')
  },

  /** The capacity caption under the fill bar: how many places are left, that the
   * event is full, or that it has no limit at all (#783, ADR-0935). */
  queryCapacityNote() {
    return container.queryByTestId('capacity-remaining')
  },

  /** The capacity fill bar. Rendered only for a CAPPED event; an uncapped event
   * (ADR-0935) has no denominator to fill against, so this is absent — which is the
   * assertion, since a bar drawn at 0% or 100% would be a fabricated one. */
  queryCapacityBar() {
    return container.queryByTestId('capacity-bar')
  },

  /** The line beneath the eligibility chips stating their true scope: the rules
   * bind rated players, and unrated players may enter (ADR-0783 §3). Absent for
   * an event with no rules — an open event carries no rated/unrated qualifier. */
  queryEligibilityScope() {
    return container.queryByTestId('eligibility-scope')
  },

  /** The count as a screen reader hears it — the sentence behind the `12 / 64`
   * numeral, which is hidden from the accessibility tree. Queried by text
   * because that IS the assertion: `sr-only` is still in the a11y tree. */
  queryEnteredSummary(summary: string) {
    return container.queryByText(summary)
  },
})

/**
 * Test page-object for `EventCard`. The card exposes the stretched open target
 * (named `Edit`/`View <event>`) plus whatever control it is given to host.
 */
export const eventCardPage = {
  render(overrides: Partial<EventCardProps> = {}) {
    render(<EventCard {...buildEventCardProps(overrides)} />)
  },

  /**
   * Every `<button>` rendered as a DOM descendant of another `<button>` —
   * invalid HTML, a keyboard trap, and an axe violation. The card hosts its own
   * controls as *siblings* of the stretched open target, so this must always be
   * empty. Structural on purpose: no role query can see nesting.
   */
  queryNestedButtons() {
    return Array.from(document.querySelectorAll('button button'))
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
