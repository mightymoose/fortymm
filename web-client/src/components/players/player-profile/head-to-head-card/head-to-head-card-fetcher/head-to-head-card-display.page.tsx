import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import {
  HeadToHeadCardDisplay,
  type HeadToHeadCardDisplayProps,
} from './head-to-head-card-display'
import { buildHeadToHeadCardDisplayProps } from './head-to-head-card-display.factory'

/** The route the never-met CTA opens — match creation, with this player already
 * picked (`?opponent=<id>`, chore 7c). Registered as a stub in the harness so the
 * typed `<Link>` resolves. */
export const NEW_MATCH_ROUTE = '/matches/new'

const scoped = (container: Container) => ({
  /**
   * The card. Found by *either* heading, on purpose: this is one component that
   * renders under two names — "Head-to-head" on somebody else's profile, "Frequent
   * opponents" on your own (there is no head-to-head with yourself). A test that
   * cares which is which asserts on `getHeadToHeadTitle()`.
   *
   * The `: HTMLElement` is load-bearing, not decoration: nearly every accessor
   * below reaches for the card through `this`, and without an explicit return type
   * TypeScript hits a circularity inferring this object literal and quietly falls
   * back to `any` — which then makes `querySelectorAll<HTMLElement>` an "untyped
   * function call" error, and would silently un-type the rest.
   */
  getHeadToHeadCard(): HTMLElement {
    return container.getByRole('region', {
      name: /head-to-head|frequent opponents/i,
    })
  },
  findHeadToHeadCard(): Promise<HTMLElement> {
    return container.findByRole('region', {
      name: /head-to-head|frequent opponents/i,
    })
  },
  queryHeadToHeadCard(): HTMLElement | null {
    return container.queryByRole('region', {
      name: /head-to-head|frequent opponents/i,
    })
  },
  /** The card's heading — which of the two cards this is. */
  getHeadToHeadTitle(): string {
    return (
      this.getHeadToHeadCard().querySelector('.player-profile__section-title')
        ?.textContent ?? ''
    )
  },
  /** The lead line on somebody else's profile: "You're 1–4 against …" — the
   * viewer's own record, which is the whole reason the card exists. `null` when
   * the pair have never met, and on your own profile. */
  queryVersusLine() {
    return this.getHeadToHeadCard().querySelector('.head-to-head__versus-line')
  },
  /** Just the record — "1–4". Scoped, so a `getByText('1–4')` can't accidentally
   * match a frequent-opponent row's identical-looking figure. */
  queryVersusRecord() {
    return this.getHeadToHeadCard().querySelector(
      '.head-to-head__versus-record',
    )
  },
  /** "5 meetings · Last met Mar 14, 2025". */
  queryVersusMeta() {
    return this.getHeadToHeadCard().querySelector('.head-to-head__versus-meta')
  },
  /** The never-met invitation — "You haven't played X yet." */
  queryInvite() {
    return this.getHeadToHeadCard().querySelector('.head-to-head__invite-copy')
  },
  /**
   * The **Start a match** CTA. `null` is a real assertion, not a missing element:
   * on your own profile the app must never offer you a match against yourself.
   */
  queryStartMatchLink() {
    return within(this.getHeadToHeadCard()).queryByRole('link', {
      name: /start a match/i,
    })
  },
  /** Where that CTA goes — must carry `?opponent=<id>` so the picker arrives
   * preseeded. */
  getStartMatchHref(): string {
    const link = this.queryStartMatchLink()
    if (!link) throw new Error('No "Start a match" link on the card')
    return link.getAttribute('href') ?? ''
  },
  /** The sub-heading over the frequent-opponents list, naming whose rivalries
   * they are ("rita.kovac's frequent opponents"). Absent on your own profile,
   * where the card's own heading already says it. */
  queryFrequentTitle() {
    return this.getHeadToHeadCard().querySelector(
      '.head-to-head__frequent-title',
    )
  },
  /** One row per frequent opponent. */
  getFrequentRows(): HTMLElement[] {
    return Array.from(
      this.getHeadToHeadCard().querySelectorAll<HTMLElement>(
        '.head-to-head__row',
      ),
    )
  },
  /** The usernames of the frequent opponents, in the order they render. */
  getFrequentOpponentNames(): string[] {
    return this.getFrequentRows().map(
      (row) =>
        row.querySelector('.head-to-head__opponent')?.textContent ?? '',
    )
  },
  /** One frequent opponent's record, by name — the **player's** wins first. */
  getFrequentRecord(username: string): string {
    const row = this.getFrequentRows().find((candidate) =>
      within(candidate).queryByText(username),
    )
    if (!row) throw new Error(`No frequent-opponent row for "${username}"`)
    return row.querySelector('.head-to-head__record')?.textContent ?? ''
  },
  /** The win-share bar's width, as the inline style sets it ("75%"). */
  getFrequentBarWidth(username: string): string {
    const row = this.getFrequentRows().find((candidate) =>
      within(candidate).queryByText(username),
    )
    if (!row) throw new Error(`No frequent-opponent row for "${username}"`)
    return (
      row.querySelector<HTMLElement>('.head-to-head__bar-fill')?.style.width ??
      ''
    )
  },
  /** The empty state, for a player who has met nobody. */
  queryFrequentEmpty() {
    return this.getHeadToHeadCard().querySelector('.head-to-head__empty')
  },
})

/**
 * Test page-object for `HeadToHeadCardDisplay` — the pure view-in, DOM-out card.
 *
 * Mounted under the router harness, because the never-met state's CTA is a typed
 * `<Link>` to match creation. That means every test against it must start with an
 * `await find…()` — the router resolves asynchronously.
 *
 * Every accessor is head-to-head-prefixed or otherwise card-scoped so the composed
 * profile page object can spread it alongside the hero's, Career's, confidence's
 * and the Leagues card's without a collision.
 */
export const headToHeadCardDisplayPage = {
  render(overrides: Partial<HeadToHeadCardDisplayProps> = {}) {
    renderWithRoutes(
      <HeadToHeadCardDisplay {...buildHeadToHeadCardDisplayProps(overrides)} />,
      { linkTargets: [NEW_MATCH_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
