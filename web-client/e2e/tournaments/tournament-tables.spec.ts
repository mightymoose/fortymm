/**
 * The **Tables tab** — the venue catalogue as an id-keyed diff (ADR 20260801).
 *
 * Two claims, and neither can be made in vitest:
 *
 * 1. **A new table goes on the wire with no `id` at all.** The server mints table ids
 *    (`TournamentTableWrite` is `extra="forbid"`), so a client-minted one is a 422
 *    naming the row. A component test can only see what the tab handed its callback;
 *    only here — MSW off, the real `openapi-fetch` doing the serializing — can a spec
 *    read the **body that was actually sent**.
 * 2. **Removing a table matches are placed at is refused, and the refusal is a
 *    question.** The server answers a 409 whose sentence names the tables, counts the
 *    matches and states both ways out; the tab renders it verbatim in a confirm, and
 *    confirming re-sends **the identical body plus the opt-in** — safe precisely
 *    because the refusal wrote nothing.
 *
 * The stub in `tournaments-store.ts` implements the whole diff (cite / insert /
 * remove) and both of its refusals, so these specs cannot pass against a stub more
 * permissive than the API.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import {
  EVENT,
  tablesInUseDetail,
  type TournamentsStoreOptions,
} from '../page-objects/tournaments/tournaments-store'

/** A tournament whose JOURNEY event has a cut draw, so there are fixtures to place. */
const DRAWN: TournamentsStoreOptions = { drawable: true, drawn: [EVENT.JOURNEY] }

test.describe('the Tables tab · adding a table', () => {
  test('sends NO id and renders the one the server minted', async ({ page }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, DRAWN)
    await pom.openTablesTab()
    const before = store.tables.length

    await pom.tableLabelInput.fill('T9')
    await pom.tableCourtInput.fill('D')
    await pom.addTableButton.click()

    // The card on screen came back from the server through the refetch.
    await expect(pom.tableCard('T9')).toBeVisible()
    await expect(pom.tablesError).toHaveCount(0)

    // What actually went on the wire: every stored table CITED by id (dropping one
    // would have removed it), and the new row with no `id` key whatsoever.
    expect(store.patchBodies).toHaveLength(1)
    const sent = store.patchBodies[0].table_catalogue!
    expect(sent).toHaveLength(before + 1)
    expect(sent.slice(0, before).map((t) => t.id)).toEqual(
      store.tables.slice(0, before).map((t) => t.id),
    )
    expect(sent[before]).toEqual({ label: 'T9', court: 'D' })
    expect('id' in sent[before]).toBe(false)
    // The opt-in is never volunteered — an add removes nothing.
    expect(
      'unplace_fixtures_on_removed_tables' in store.patchBodies[0],
    ).toBe(false)

    // And the id the catalogue now holds for it is the SERVER's uuid.
    const minted = store.tables[before]
    expect(minted.label).toBe('T9')
    expect(minted.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(store.unhandled).toEqual([])
  })
})

test.describe('the Tables tab · removing a table matches are placed at', () => {
  test('refuses with the server’s sentence, and confirming completes it', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN,
      placed: EVENT.JOURNEY,
    })
    await pom.openTablesTab()
    const doomed = store.tables[0]

    await pom.removeTableButton(doomed.label).click()

    // The confirm carries the API's own words — it names the table by LABEL, counts
    // the matches, and states both ways out. None of that is reconstructible client
    // side, which is why it is shown verbatim.
    await expect(pom.removeTableConfirmDetail).toHaveText(
      tablesInUseDetail([doomed.label], 1),
    )
    await expect(pom.removeTableConfirmDetail).not.toContainText(doomed.id)
    // Nothing was written: the refusal is a refusal, not a report.
    expect(store.tables.map((t) => t.id)).toContain(doomed.id)
    expect(store.fixturesOf(EVENT.JOURNEY)[0].table_id).toBe(doomed.id)

    await pom.removeTableConfirmButton.click()

    await expect(pom.removeTableConfirm).toHaveCount(0)
    await expect(pom.tableCard(doomed.label)).toHaveCount(0)
    expect(store.tables.map((t) => t.id)).not.toContain(doomed.id)
    // The matches lost table, time AND pin together — a start with no table is a bar
    // on a schedule with nowhere to be.
    const fixture = store.fixturesOf(EVENT.JOURNEY)[0]
    expect(fixture.table_id).toBeNull()
    expect(fixture.scheduled_start).toBeNull()
    expect(fixture.pinned_at).toBeNull()

    // The confirm re-sent the SAME diff, plus the opt-in — the answer is to the
    // question that was asked, not to a catalogue recomputed in between.
    expect(store.patchBodies).toHaveLength(2)
    const [refused, confirmed] = store.patchBodies
    expect(confirmed.table_catalogue).toEqual(refused.table_catalogue)
    expect(refused.unplace_fixtures_on_removed_tables).toBeUndefined()
    expect(confirmed.unplace_fixtures_on_removed_tables).toBe(true)
    expect(store.unhandled).toEqual([])
  })

  test('keeping the table sends nothing', async ({ page }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN,
      placed: EVENT.JOURNEY,
    })
    await pom.openTablesTab()
    const doomed = store.tables[0]

    await pom.removeTableButton(doomed.label).click()
    await expect(pom.removeTableConfirmDetail).toBeVisible()
    await pom.removeTableCancelButton.click()

    await expect(pom.removeTableConfirm).toHaveCount(0)
    await expect(pom.tableCard(doomed.label)).toBeVisible()
    expect(store.tables.map((t) => t.id)).toContain(doomed.id)
    expect(store.fixturesOf(EVENT.JOURNEY)[0].table_id).toBe(doomed.id)
    // One PATCH — the refused one. Cancelling is the absence of a request.
    expect(store.patchBodies).toHaveLength(1)
  })

  // The quiet half of the ADR's split: a reservation's `table_ids` are a HOLD, not a
  // placement, so removing a table nothing stands on needs no ceremony at all.
  test('a table nothing is placed at goes without a confirm', async ({ page }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN,
      placed: EVENT.JOURNEY,
    })
    await pom.openTablesTab()
    // The LAST table — the placement above is on the first.
    const spare = store.tables[store.tables.length - 1]

    await pom.removeTableButton(spare.label).click()

    await expect(pom.tableCard(spare.label)).toHaveCount(0)
    expect(store.tables.map((t) => t.id)).not.toContain(spare.id)
    await expect(pom.removeTableConfirm).toHaveCount(0)
    await expect(pom.tablesError).toHaveCount(0)
    // The placed fixture on the OTHER table was not touched.
    expect(store.fixturesOf(EVENT.JOURNEY)[0].table_id).toBe(store.tables[0].id)
  })
})
