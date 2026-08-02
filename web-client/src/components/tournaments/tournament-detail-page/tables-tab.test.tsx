import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'
import {
  findTournament,
  placeFixture,
  resetTournamentsStore,
} from '@/mocks/tournaments-store'
import { render, screen, waitFor } from '@/test/utilities'

import {
  useTables,
  useTournament,
  useUpdateTableCatalogue,
} from '../data/api'
import { buildTable, buildTables } from '../data/seed.factory'
import type { TournamentTableEntry } from '../data/types'
import { TablesTab } from './tables-tab'
import { tablesTabPage } from './tables-tab.page'

/** The recorded calls of a fake `onChangeCatalogue`, plus the answer it gives.
 * Resolves by default — the tab clears the add form only on the success path. */
function spyCatalogue(answer: () => Promise<void> = () => Promise.resolve()) {
  const calls: {
    entries: TournamentTableEntry[]
    options: { unplaceFixturesOnRemovedTables: boolean }
  }[] = []
  return {
    calls,
    onChangeCatalogue: async (
      entries: TournamentTableEntry[],
      options: { unplaceFixturesOnRemovedTables: boolean },
    ) => {
      calls.push({ entries, options })
      await answer()
    },
  }
}

describe('TablesTab', () => {
  // ----- the diff a catalogue edit really is (ADR 20260801) ------------------
  //
  // A catalogue write is an **id-keyed diff**, not a replace: an entry citing an id
  // means "this existing table", an entry with no id means "create this one", and a
  // stored table no entry cites is REMOVED. So what this tab emits is not a list of
  // tables — it is a list of *intents*, and these are the assertions that it says the
  // one it means.

  it('adds a table with NO id — the server mints it', async () => {
    const spy = spyCatalogue()
    tablesTabPage.render({ catalogue: buildTables(2), ...spy })

    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    await userEvent.type(tablesTabPage.getCourtInput(), '9')
    await userEvent.click(tablesTabPage.getAddButton())

    await waitFor(() => expect(spy.calls).toHaveLength(1))
    const { entries } = spy.calls[0]
    // The two stored tables are CITED — they are kept, not re-created. Under an
    // id-keyed diff, dropping them from the payload would delete them.
    expect(entries.slice(0, 2)).toEqual([
      { kind: 'kept', table: buildTable({ id: 't1', label: 'T1', court: '1' }) },
      { kind: 'kept', table: buildTable({ id: 't2', label: 'T2', court: '2' }) },
    ])
    // And the new one carries no id at ALL — not a minted one, not a null one.
    // `TournamentTableWrite` is `extra="forbid"`, so an id here is a 422 (and, against
    // the patch shape, an id naming no table of this tournament is a 422 too).
    expect(entries[2]).toEqual({ kind: 'added', label: 'T9', court: '9' })
    expect('id' in entries[2]).toBe(false)
    // The destructive opt-in is never volunteered — an add removes nothing.
    expect(spy.calls[0].options).toEqual({ unplaceFixturesOnRemovedTables: false })
  })

  it('removes a table by leaving it OUT of the cited catalogue', async () => {
    const spy = spyCatalogue()
    tablesTabPage.render({ catalogue: buildTables(3), ...spy })

    await userEvent.click(tablesTabPage.getRemoveButton('T1'))

    await waitFor(() => expect(spy.calls).toHaveLength(1))
    expect(spy.calls[0].entries).toEqual([
      { kind: 'kept', table: buildTable({ id: 't2', label: 'T2', court: '2' }) },
      { kind: 'kept', table: buildTable({ id: 't3', label: 'T3', court: '3' }) },
    ])
    // The first attempt NEVER opts in: the whole point of the flag is that a director
    // says it on purpose, having read the refusal.
    expect(spy.calls[0].options).toEqual({ unplaceFixturesOnRemovedTables: false })
  })

  // The card renders "Court {court}", so the value stored is a BARE identifier. The
  // placeholder must hint that bare value, never "Court", or a user who follows it
  // types "Court A" and the card reads "Court Court A".
  it('hints a bare Court value, not "Court", so "Court Court A" is impossible', async () => {
    const spy = spyCatalogue()
    tablesTabPage.render({ catalogue: buildTables(2), ...spy })

    const placeholder = tablesTabPage.getCourtPlaceholder()
    expect(placeholder).not.toBe('Court')
    expect(placeholder).not.toMatch(/court/i)

    // A user following the placeholder types just "A".
    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    await userEvent.type(tablesTabPage.getCourtInput(), 'A')
    await userEvent.click(tablesTabPage.getAddButton())

    await waitFor(() => expect(spy.calls).toHaveLength(1))
    // Stored raw as "A" (not "Court A") → the card's "Court " prefix reads "Court A".
    expect(spy.calls[0].entries[2]).toEqual({
      kind: 'added',
      label: 'T9',
      court: 'A',
    })
  })

  // The card prepends "Court " to the raw value, so a bare "A" reads "Court A"
  // (and never the "Court Court A" a "Court"-nudged value would produce).
  it('renders a bare court value as "Court A" on the card', () => {
    tablesTabPage.render({
      catalogue: [buildTable({ id: 't1', label: 'T1', court: 'A' })],
    })

    expect(document.body).toHaveTextContent('Court A')
    expect(document.body).not.toHaveTextContent('Court Court A')
  })

  it('keeps the add button disabled until a label is entered', async () => {
    tablesTabPage.render({ catalogue: buildTables(2) })

    expect(tablesTabPage.getAddButton()).toBeDisabled()
    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    expect(tablesTabPage.getAddButton()).toBeEnabled()
  })

  // A modal/form that clears itself over a rejected write has silently thrown the
  // organizer's work away (#614, #933). The add form is the same contract: it empties
  // only on the success path.
  it('keeps the typed label and court when the add is refused', async () => {
    const spy = spyCatalogue(() => Promise.reject(new Error('nope')))
    tablesTabPage.render({ catalogue: buildTables(2), ...spy })

    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    await userEvent.type(tablesTabPage.getCourtInput(), '9')
    await userEvent.click(tablesTabPage.getAddButton())

    await waitFor(() => expect(tablesTabPage.queryError()).not.toBeNull())
    expect(tablesTabPage.getLabelInput()).toHaveValue('T9')
    expect(tablesTabPage.getCourtInput()).toHaveValue('9')
  })

  it('hides the add-table form and per-row removes for a non-creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: false })

    expect(tablesTabPage.queryAddButton()).toBeNull()
    expect(tablesTabPage.queryRemoveButton('T1')).toBeNull()
    // The table list itself stays visible (read-only).
    expect(document.body).toHaveTextContent('T1')
  })

  // ADR-0015 rule 6: a non-owner gets a rendering, never controls — and the DOM
  // sweep (not a role query) is the discriminating guard. The catalogue's whole
  // editor — the add-table inputs and every per-row Remove — is gone, not disabled.
  it('renders no interactive controls for a non-creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: false })

    expect(tablesTabPage.getControls()).toHaveLength(0)
  })

  // The other half, so the guard above cannot be satisfied by deleting the form for
  // everyone: the creator still gets the full catalogue editor.
  it('gives the creator the catalogue editor', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: true })

    expect(tablesTabPage.getControls().length).toBeGreaterThan(0)
  })

  // The subtitle's second sentence is an instruction only the organizer can
  // follow (ADR 0015, rule 5: copy addresses the reader). Both halves of this
  // pair matter: dropping the sentence for *everyone* would satisfy the
  // non-creator assertion alone.
  it('keeps the organizer-voiced subtitle for the creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: true })

    expect(document.body).toHaveTextContent(
      'The physical tables available at this venue. Add them to pools when configuring events.',
    )
  })

  it('drops the organizer-voiced subtitle for a non-creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: false })

    expect(document.body).toHaveTextContent(
      'The physical tables available at this venue.',
    )
    expect(document.body).not.toHaveTextContent('Add them to pools')
  })
})

// ---------------------------------------------------------------------------
// The tab against the API — MSW + the tournaments store, which enforces the real
// contract (id-keyed diff, minted ids, the in-use 409). The fakes above prove what
// the tab *emits*; these prove the loop, which is a different claim: a
// client-minted id is not merely unwanted, it is a **422** naming the row, and the
// removal refusal is not a string this file invented but the sentence the server
// composes (`_tables_in_use_detail`, `api/app/tournament_tables.py`).
//
// The harness is the detail route's wiring, minus the route: the same query, the
// same mutation, the same `mutateAsync` whose rejection reaches the tab.
// ---------------------------------------------------------------------------

/** The seeded, owned `draft` tournament — a catalogue of `t1`… tables and one drawn
 * event whose fixtures start UNPLACED. Its size is read from the store rather than
 * written down here: what these tests assert is the DELTA an edit makes. */
const SLAM = 'summer-slam-2026'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const catalogueOf = (id: string) => findTournament(id)!.table_catalogue
const fixturesOf = (id: string) =>
  findTournament(id)!.events.flatMap((e) => e.fixtures)

function TablesTabHarness({ tournamentId }: { tournamentId: string }) {
  const { data: tournament } = useTournament(tournamentId)
  const catalogue = useTables(tournamentId)
  const save = useUpdateTableCatalogue(tournamentId)
  if (!tournament) return <p>Loading…</p>
  return (
    <TablesTab
      tournament={tournament}
      catalogue={catalogue}
      canEdit
      onChangeCatalogue={async (entries, options) => {
        await save.mutateAsync({ entries, ...options })
      }}
    />
  )
}

/** Place the drawn event's first fixture on `T1` — a full placement, so it pins.
 * The pin is what makes "all three placement columns go together" a real assertion
 * once the removal goes through. */
function placeAMatchOnT1(): { fixtureId: string; tableId: string } {
  const tableId = catalogueOf(SLAM)[0].id
  const fixtureId = fixturesOf(SLAM)[0].id
  const placed = placeFixture(SLAM, fixtureId, {
    table_id: tableId,
    scheduled_start: '2026-06-13T09:00:00',
  })
  if (!placed.ok) throw new Error('setup failed: could not place the fixture')
  return { fixtureId, tableId }
}

describe('TablesTab against the API', () => {
  beforeEach(() => resetTournamentsStore())

  it('adds a table with no id and renders the one the SERVER minted', async () => {
    const before = catalogueOf(SLAM)
    render(<TablesTabHarness tournamentId={SLAM} />)
    await screen.findByLabelText('Remove T1')

    await userEvent.type(tablesTabPage.getLabelInput(), 'T13')
    await userEvent.type(tablesTabPage.getCourtInput(), 'D')
    await userEvent.click(tablesTabPage.getAddButton())

    // The row on screen is the SERVER's, arriving through the refetch — not an
    // optimistic local echo.
    await screen.findByLabelText('Remove T13')
    expect(tablesTabPage.queryError()).toBeNull()

    const stored = catalogueOf(SLAM)
    expect(stored).toHaveLength(before.length + 1)
    expect(stored[before.length]).toEqual({
      id: expect.stringMatching(UUID),
      label: 'T13',
      court: 'D',
    })
    // The stored rows are untouched — an add is an insert, not a re-mint of the
    // catalogue (which is what a positional overwrite would have been).
    expect(stored.slice(0, before.length)).toEqual(before)
    // The falsification this test really carries: a client-minted id would name no
    // table of this tournament, so the store would 422 and nothing would be added.
  })

  it('asks before removing a table matches are placed at, in the SERVER’s words', async () => {
    const { tableId } = placeAMatchOnT1()
    const before = catalogueOf(SLAM)
    render(<TablesTabHarness tournamentId={SLAM} />)
    await screen.findByLabelText('Remove T1')

    await userEvent.click(tablesTabPage.getRemoveButton('T1'))

    // Verbatim: it names the table by LABEL, counts the matches, and states both ways
    // out — none of which this client could reconstruct.
    const detail = await screen.findByTestId('confirm-remove-table-detail')
    expect(detail).toHaveTextContent(
      '“T1” has 1 match placed at it, so removing it from the catalogue would leave ' +
        'those matches with no table — indistinguishable from matches nobody ever ' +
        'placed. To remove it anyway, send the same edit again with ' +
        '“unplace_fixtures_on_removed_tables”: true, and those matches lose their ' +
        'table, their time and their call and go back to the schedule to be placed ' +
        'again. To keep them where they are, leave the table in the catalogue and ' +
        'move the matches off it first.',
    )
    // Never the id — a uuid tells a director looking at a page of named tables
    // nothing to act on.
    expect(detail.textContent).not.toContain(tableId)
    // And NOTHING was written: the refusal is a refusal, not a report.
    expect(catalogueOf(SLAM)).toEqual(before)
    expect(fixturesOf(SLAM)[0].table_id).toBe(tableId)
  })

  it('completes the removal when the organizer confirms, unplacing those matches', async () => {
    const { fixtureId, tableId } = placeAMatchOnT1()
    const before = catalogueOf(SLAM)
    render(<TablesTabHarness tournamentId={SLAM} />)
    await screen.findByLabelText('Remove T1')

    await userEvent.click(tablesTabPage.getRemoveButton('T1'))
    await screen.findByTestId('confirm-remove-table-detail')

    await userEvent.click(tablesTabPage.getConfirmRemoveButton())

    // The STORE first, deliberately: it names what it holds, so a red here reads
    // "the table is still in the catalogue" rather than the undiscriminated
    // "timed out" a DOM-absence wait would give (see the timeout note in
    // `web-client/CLAUDE.md`).
    await waitFor(() =>
      expect(catalogueOf(SLAM).map((t) => t.id)).not.toContain(tableId),
    )
    expect(catalogueOf(SLAM)).toHaveLength(before.length - 1)
    // …and the row leaves the screen through the refetch.
    await waitFor(() => expect(screen.queryByLabelText('Remove T1')).toBeNull())
    // …the dialog closed itself, and no failure was reported…
    await waitFor(() => expect(tablesTabPage.queryConfirmDialog()).toBeNull())
    expect(tablesTabPage.queryError()).toBeNull()
    // …and all THREE placement columns went together: a start with no table is a bar
    // on a schedule with nowhere to be, and a pin is a promise about a table.
    const fixture = fixturesOf(SLAM).find((f) => f.id === fixtureId)!
    expect(fixture.table_id).toBeNull()
    expect(fixture.scheduled_start).toBeNull()
    expect(fixture.pinned_at).toBeNull()
  })

  it('sends nothing when the organizer keeps the table', async () => {
    const { tableId } = placeAMatchOnT1()
    render(<TablesTabHarness tournamentId={SLAM} />)
    await screen.findByLabelText('Remove T1')

    await userEvent.click(tablesTabPage.getRemoveButton('T1'))
    await screen.findByTestId('confirm-remove-table-detail')
    await userEvent.click(tablesTabPage.getConfirmCancelButton())

    await waitFor(() => expect(tablesTabPage.queryConfirmDialog()).toBeNull())
    expect(catalogueOf(SLAM).map((t) => t.id)).toContain(tableId)
    expect(fixturesOf(SLAM)[0].table_id).toBe(tableId)
    expect(screen.getByLabelText('Remove T1')).toBeInTheDocument()
  })

  // The confirm is for ONE refusal. A 403 is also a 4xx the server explains in a
  // sentence — and re-sending it with the destructive opt-in would refuse
  // identically, while asking the director to authorise their own lockout.
  it('reports a non-409 refusal inline — never as a confirm', async () => {
    server.use(
      http.patch('*/v1/tournaments/:tournamentId', () =>
        HttpResponse.json(
          { detail: 'Only the creator can edit this tournament.' },
          { status: 403 },
        ),
      ),
    )
    render(<TablesTabHarness tournamentId={SLAM} />)
    await screen.findByLabelText('Remove T1')

    await userEvent.click(tablesTabPage.getRemoveButton('T1'))

    await waitFor(() =>
      expect(tablesTabPage.queryError()).toHaveTextContent(
        'Only the creator can edit this tournament.',
      ),
    )
    expect(tablesTabPage.queryConfirmDialog()).toBeNull()
  })
})
