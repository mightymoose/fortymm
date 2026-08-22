import { test, expect, type Page, type Response } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  callFixture,
  cutDraw,
  firstFixture,
  getTableCatalogue,
  seedEntrants,
  seedTournament,
  transitionTournament,
  type ReservationSpec,
  type TableSpec,
} from '../support/tournament-api'

/** The table the director tries to remove — the one a match is placed at. */
const DOOMED = 'Table 1'
/** A second table, in the catalogue but booked by no reservation. It is the witness
 * that the confirmed removal removed **that** table and not the catalogue: a one-table
 * venue could not tell "the diff removed the table I cited" from "the write replaced
 * the catalogue wholesale". */
const SPARE = 'Table 2'

/** A two-table venue, sent with **no ids** — the server mints them (ADR 20260801). */
const TABLES: ReadonlyArray<TableSpec> = [
  { label: DOOMED, court: 'A' },
  { label: SPARE, court: 'B' },
]

/**
 * One reservation, booking **only the doomed table**.
 *
 * That is not scene-setting, it is what makes the last assertion of this spec a fact
 * rather than a race. A catalogue edit that changes the *set* of tables on a tournament
 * with a cut draw enqueues a `settings_changed` schedule solve (`tournament_edit`), and
 * this stack runs a real solver on a real worker — so between the confirmed removal and
 * the read that checks the fixture came back unplaced, a solve could otherwise land and
 * re-place it, and the spec would flake on correct behaviour.
 *
 * A reservation's `table_ids` are intersected with the catalogue when the solver's
 * inputs are loaded ("a stale ref is a table the reservation cannot use"), so once
 * `Table 1` is gone this reservation's group has **zero** usable tables and its one
 * fixture has nowhere to go: the solve is honestly infeasible and applies nothing.
 * `Table 2` stays in the catalogue as a table no reservation books — a spare, which is
 * a perfectly ordinary thing for a venue to have.
 */
const RESERVATIONS: ReadonlyArray<ReservationSpec> = [
  { name: 'Reservation A', tableLabels: [DOOMED] },
]

/** A uuid — what a table id is now that the catalogue is a real table with a
 * `gen_random_uuid()` primary key. Asserted on the seed so that "the label is not the
 * id" is established before the spec starts leaning on the difference. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * **Removing a table that a match is placed at is refused — and the match keeps its
 * placement** (#1226, ADR 20260801 "a placement names a real table, and only that is an
 * invariant").
 *
 * A director opens the Tables tab of a tournament whose one fixture is placed at
 * `Table 1`, and clicks Remove on it. The server answers a **409** whose sentence names
 * the table by label and states both ways out; the tab renders that sentence verbatim in
 * a confirm; and — the half worth having end to end — **the fixture is still placed**.
 * Confirming re-sends the same edit with the opt-in, the removal goes through, and the
 * fixture comes back with no table, no time and no pin.
 *
 * ## Why this claim needs the composed stack
 *
 * The api tests prove the refusal in isolation and the web-client's own e2e suite proves
 * the dialog against a `page.route` stub that *implements* the 409. Neither can say the
 * two halves meet: the sentence in the dialog is composed by
 * `_tables_in_use_detail` on the server and shown verbatim by the client, so a stub that
 * words it differently — or a client that reworded it, or a `saveFailure`
 * classification that stopped landing in the `refused` arm — is invisible to both. Here
 * the dialog's text is compared against **the body of the very response that opened
 * it**, read off the wire. Nothing in this spec writes that sentence down; if the two
 * ever diverge, this is the only suite that can notice.
 *
 * The same goes for "nothing was written". A stub can be made to answer 409 and mutate
 * nothing by construction. Only a real API can be *wrong* about it — the refusal is
 * raised after the diff has been computed and before the catalogue collection is
 * reassigned — so the placement is read back over the API on **both** sides of the
 * refusal, from the same rows the browser is looking at.
 *
 * ## Seed vs UI split
 *
 * Over the API (`support/tournament-api.ts`): the tournament and its two-table
 * catalogue, the event, the publish, two director-entered entrants, the draw, and the
 * placement — a placement drag has no simple UI surface to drive, and none of it is the
 * subject. In the browser: the Tables tab, the Remove click, the confirm, and the cards
 * on either side.
 *
 * The tournament is left **published**, never live. Going live would materialize the
 * fixture into a real match and auto-enqueue a solve that places every fixture for us,
 * which buys no part of this claim and costs the determinism the reservation above was
 * shaped to get. What the server counts and calls "matches placed at" a table is the fixture's
 * placement, which is exactly what is seeded here.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — removing a table that is in use', () => {
  test('is refused with the server’s sentence and keeps the placement, until the director confirms', async ({
    page,
    baseURL,
  }) => {
    // Two minted guests, a real draw cut and two round-trips through the browser —
    // comfortably past the 30s default, and every wait below is bounded.
    test.setTimeout(180_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session (`page.request` shares its cookie jar),
    // so the page sees the owner-only Remove buttons.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- seed: a two-table venue, one reservation over the doomed table -----
    const name = `Tables ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, tables } = await seedTournament(director, name, {
      tables: TABLES,
      reservations: RESERVATIONS,
    })
    const doomed = tables.find((table) => table.label === DOOMED)!
    const spare = tables.find((table) => table.label === SPARE)!
    // The ids are the SERVER's — the seed sent none. Everything below distinguishes the
    // label (what the refusal speaks) from the id (what the diff keys on), so establish
    // here that they are genuinely different things.
    expect(doomed.id).toMatch(UUID)
    expect(spare.id).toMatch(UUID)

    // ----- a field, a draw, and a fixture placed at the doomed table ----------
    await transitionTournament(director, tournamentId, 'published')
    const entrants = await seedEntrants(director, baseURL!, tournamentId, eventId, 2)
    await cutDraw(director, tournamentId, eventId)
    const fixture = await firstFixture(director, tournamentId, eventId)
    await callFixture(director, tournamentId, fixture.id, doomed.id)

    const placed = await firstFixture(director, tournamentId, eventId)
    expect(placed.table_id, 'the seeded fixture must be placed at the doomed table').toBe(
      doomed.id,
    )
    expect(placed.scheduled_start).not.toBeNull()

    // ----- the browser: the Tables tab, with both tables on it ----------------
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // `toContainText`, not `toHaveText`: the hero sets its own full stop after the name.
    // The long timeout is for the FIRST navigation only, and it is about the stack rather
    // than the app — the composed web-client is a Vite **dev** server, so the first
    // request for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })
    const tablesTab = await detail.openTables()
    await expect(tablesTab.root).toBeVisible()
    await expect(tablesTab.tableCard(DOOMED)).toBeVisible()
    await expect(tablesTab.tableCard(SPARE)).toBeVisible()

    // ----- Remove the doomed table: the server refuses -----------------------
    const refusalSent = catalogueWrite(page, tournamentId)
    await tablesTab.removeTableButton(DOOMED).click()
    const refusal = await refusalSent
    // Asserted on the RESPONSE, before anything about the dialog. A red here reads
    // "Expected: 409, Received: 200" and names the reason outright; the same broken
    // guard seen only through the dialog would red as an undiscriminated "waiting for
    // locator" timeout that cannot tell a permitted removal from a dialog that never
    // rendered.
    expect(
      refusal.status(),
      'removing a table with a match placed at it must be refused',
    ).toBe(409)
    const sentence = ((await refusal.json()) as { detail: string }).detail

    // The refused write did NOT volunteer the opt-in — so the 409 is the server's
    // judgement on a plain removal, not an answer to a request that asked to be refused.
    expect(refusal.request().postDataJSON()).not.toHaveProperty(
      'unplace_fixtures_on_removed_tables',
    )

    // ----- the dialog carries the server's own sentence, verbatim ------------
    await expect(tablesTab.removeTableConfirm).toBeVisible()
    await expect(tablesTab.removeTableConfirmDetail).toHaveText(sentence)
    // Named by LABEL and never by id: the id is what the diff compared, but "table
    // 4f9c-… cannot be removed" tells a director looking at a page of named tables
    // nothing to act on.
    expect(sentence).toContain(DOOMED)
    expect(sentence).not.toContain(doomed.id)
    // The refusal is a question, not an error — it must not also land in the inline
    // failure banner the client words itself.
    await expect(tablesTab.tablesError).toHaveCount(0)

    // ----- …and NOTHING was written -----------------------------------------
    // The load-bearing half. "A dialog appeared" is satisfied by a server that refused
    // *after* unplacing; these two reads are what say the tournament is byte-identical.
    expect(
      (await getTableCatalogue(director, tournamentId)).map((t) => t.id),
      'a refused catalogue edit must leave the catalogue untouched',
    ).toEqual([doomed.id, spare.id])
    const kept = await firstFixture(director, tournamentId, eventId)
    expect(kept.table_id, 'the refused removal must leave the match placed').toBe(
      doomed.id,
    )
    expect(kept.scheduled_start?.instant).toBe(placed.scheduled_start?.instant)
    expect(kept.pinned_at?.instant).toBe(placed.pinned_at?.instant)

    // ----- confirm: the same edit, plus the opt-in ---------------------------
    const confirmSent = catalogueWrite(page, tournamentId)
    await tablesTab.removeTableConfirmButton.click()
    const confirmed = await confirmSent
    expect(
      confirmed.status(),
      `the confirmed removal was refused: ${await confirmed.text()}`,
    ).toBe(200)
    expect(
      confirmed.request().postDataJSON().unplace_fixtures_on_removed_tables,
      'only an explicit true opts in to unplacing',
    ).toBe(true)

    // The card goes, the spare stays, and no failure is reported.
    await expect(tablesTab.removeTableConfirm).toHaveCount(0)
    await expect(tablesTab.tableCard(DOOMED)).toHaveCount(0)
    await expect(tablesTab.tableCard(SPARE)).toBeVisible()
    await expect(tablesTab.tablesError).toHaveCount(0)

    // ----- and the fixture comes back unplaced ------------------------------
    expect(
      (await getTableCatalogue(director, tournamentId)).map((t) => t.id),
      'the confirmed removal must take the cited table and only it',
    ).toEqual([spare.id])
    const unplaced = await firstFixture(director, tournamentId, eventId)
    // All three placement columns go together: a start with no table is a bar on a
    // schedule with nowhere to be, and a `pinned_at` is a promise about a table.
    expect(unplaced.table_id).toBeNull()
    expect(unplaced.scheduled_start).toBeNull()
    expect(unplaced.pinned_at).toBeNull()

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})

/**
 * The next **catalogue write** the page makes — the `PATCH /v1/tournaments/{id}` the
 * Tables tab sends, awaited from before the click that causes it.
 *
 * Taken off the wire rather than inferred from the screen because the two things this
 * spec most needs are only there: the 409's status (a discriminating red, where a dialog
 * that never opened is only a timeout) and its `detail`, which is the sentence the
 * dialog must be showing verbatim.
 */
function catalogueWrite(page: Page, tournamentId: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith(`/tournaments/${tournamentId}`),
  )
}
