import { interactiveElementsIn } from '@/test/read-only'
import { SessionProbe } from '@/test/session-probe'
import { render, screen, type Container } from '@/test/utilities'

import {
  TournamentDetailPage,
  type TournamentDetailPageProps,
} from './tournament-detail-page'
import { buildTournamentDetailPageProps } from './tournament-detail-page.factory'
import { confirmIrreversibleActDialogPage } from './tournament-detail-page/confirm-irreversible-act-dialog.page'
import { eventsTabPage } from './tournament-detail-page/events-tab.page'

const scoped = (container: Container) => ({
  getTab(name: string | RegExp) {
    return container.getByRole('tab', { name })
  },
  /** The currently-active tab panel — Radix unmounts the inactive ones, so there
   * is exactly one in the DOM. The scope a per-tab read-only sweep runs over: the
   * tab STRIP (its triggers) sits outside it, so it is never miscounted as a
   * control. */
  getActiveTabPanel() {
    return container.getByRole('tabpanel')
  },
  /** Every interactive control in the active tab panel, swept over the DOM
   * (ADR-0015 rule 6 — never an ARIA-role sweep, which under-proves). The guard a
   * "this tab is a read-only view for a non-owner" assertion needs. */
  getActiveTabControls() {
    return interactiveElementsIn(container.getByRole('tabpanel'))
  },
  /** Resolves once `/v1/session` has landed (`SessionProbe`). Gate a non-owner
   * *absence* assertion on this: permission-gated controls read as absent while the
   * session is still in flight, so an un-gated assertion passes vacuously. */
  findSessionReady() {
    return container.findByTestId('session-ready')
  },
  getBackCrumb() {
    return container.getByRole('button', { name: 'Tournaments' })
  },
  getLifecycleButton(name: RegExp) {
    return container.getByRole('button', { name })
  },
  /** The **confirm** every lifecycle edge is gated by (ADR "a confirm prices an
   * irreversible act…"): the header's button opens it and posts nothing, and the
   * transition is fired by the dialog's own button. Addressed at `screen` whatever the
   * scope, because the dialog portals to the document body.
   *
   * Named `lifecycleConfirm`, not `confirm`: the Events tab spreads a `confirm` of its
   * own for the two draw acts, and one name for both would be the last spread silently
   * winning. The rename buys a readable call site, **not** isolation — there is one
   * dialog component behind one testid, so both accessors resolve to whichever act is
   * open. Nothing here opens two at once, and nothing should. */
  lifecycleConfirm: confirmIrreversibleActDialogPage.within(screen),
  /** The hero's status pill (`StatusBadge`) — the page's one claim about where the
   * tournament stands. Read it after a refused transition: nothing here is optimistic,
   * so a refused **Start tournament** must leave it saying **Published**. */
  getStatusBadge() {
    return container.getByTestId('tournament-status-badge')
  },
  /** The header's inline lifecycle refusal, as one normalised string — title and the
   * server's sentence beneath it. */
  async findLifecycleNoticeText() {
    const notice = await container.findByTestId('lifecycle-notice')
    return (notice.textContent ?? '').replace(/\s+/g, ' ').trim()
  },
  /** The Days stat's figure and its unit, read as one string. The unit is a
   * styled `<span>` sitting beside the figure, so the DOM text carries no space
   * ("2days") even though a CSS margin renders one — assert against the DOM, not
   * against what the eye sees. */
  getDaysStat() {
    return container.getByText('Days', { selector: 'div' }).previousElementSibling
      ?.textContent
  },
  queryLifecycleButton(name: RegExp) {
    return container.queryByRole('button', { name })
  },
  /** The header's venue meta item (pin icon + address). The whole item — icon
   * included — is absent when venue, city, and region are all blank, so this is
   * a `query`: its absence is the assertion (#994). */
  queryVenueLine() {
    return container.queryByTestId('tournament-venue-line')
  },
  /** The venue line's **text**, without the pin beside it. Separate from
   * `queryVenueLine` because the wrapping treatment (#1199) is on this span, and
   * an assertion about the row's classes would say nothing about it. */
  queryVenueText() {
    return container.queryByTestId('tournament-venue-text')
  },
  /** The venue `LocationMap`'s text fallback — the branch rendered when no Google
   * Maps key is configured (dev/CI/vitest all run keyless). Its text is the venue
   * line. Absent when the tournament has no address. */
  queryVenueMapFallback() {
    return container.queryByTestId('location-map-fallback')
  },
  ...eventsTabPage.within(container),
})

/** Test page-object for `TournamentDetailPage`. */
export const tournamentDetailPagePage = {
  render(overrides: Partial<TournamentDetailPageProps> = {}) {
    render(
      <>
        {/* Inert marker so a test can `await findSessionReady()` before asserting a
            permission-gated control is absent (the page already fetches the session
            itself — this only exposes when it lands). */}
        <SessionProbe />
        <TournamentDetailPage {...buildTournamentDetailPageProps(overrides)} />
      </>,
    )
  },
  /** The event editor's save button (the sheet portals to the body). */
  getEditorSaveButton() {
    return screen.getByRole('button', { name: /Create event|Save changes/ })
  },
  /** The editor's name field (the sheet portals to the body). A NEW event starts
   * blank (`emptyEvent`), and a blank name is refused in the form — so a page-level
   * test that wants to reach the *server* has to fill this in first, exactly as an
   * organizer does. */
  getEditorNameInput() {
    return screen.getByLabelText(/Event name/)
  },
  /** The editor's player-limit field. Blanking it is how a page-level test authors
   * an **uncapped** event (ADR-0935) — the save then carries `maxPlayers: null`. */
  getEditorPlayerLimitInput() {
    return screen.getByLabelText(/Player limit/)
  },
  /** The event editor sheet — present exactly while it is open. A refused save
   * must leave it here, holding the organizer's work. */
  queryEditor() {
    return screen.queryByRole('dialog')
  },
  /** The editor's report of a refused save. */
  queryEditorFailure() {
    return screen.queryByTestId('event-editor-error')
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
