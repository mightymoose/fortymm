import userEvent from '@testing-library/user-event'
import { delay, HttpResponse } from 'msw'

import {
  mockEventCutDrawEndpoint,
  mockEventUncutDrawEndpoint,
} from '@/mocks/endpoints/tournaments/tournaments.endpoint'
import { buildTournamentFixtureRead } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import {
  buildBracketDrawnEvent,
  buildDrawnEvent,
  buildEntrants,
  buildEvent,
  buildFixture,
  buildMaterializedDrawnEvent,
  buildPlayedDrawnEvent,
  buildPool,
  buildSwissDrawnEvent,
  buildTenPoolDrawnEvent,
  buildTwoStageDrawnEvent,
  TEN_POOLS_BY_ID,
  TEN_POOLS_BY_POSITION,
} from '../../data/seed.factory'
import { drawPanelPage as page } from './draw-panel.page'

/** The seeded drawn event: round-robin, `player.1`…`player.5`, Pool A (1/4/5 — odd) and
 * Pool B (2/3). */
const DRAWN = buildDrawnEvent()

/** The same draw, **under way**: one of its four fixtures has a recorded winner. Nothing
 * else differs — a winner is not drawn on a fixture line — so the freeze is the only thing
 * that can make a test here read differently from the same test against `DRAWN`. */
const PLAYED = buildPlayedDrawnEvent()

/** The panel's own verbs that are still live — swept by DOM rather than by role, because
 * an open dialog puts `aria-hidden` over everything behind it and a role query then finds
 * none of them. A drawn event offers exactly two, and both go dead while a draw verb is
 * in flight, so the count is a synchronous read of "nothing was sent". */
const enabledVerbsIn = (eventId: string) =>
  page.getPanelControls(eventId).filter((el) => !el.hasAttribute('disabled'))

/** What a successful cut answers with. The panel does not read it — the refetched
 * tournament carries the new draw — but it must be a payload the parser accepts, or the
 * mutation rejects and the test would be asserting against a *failed* cut. */
const cutResponse = () => [
  buildTournamentFixtureRead({
    id: 'fx-a-1',
    pool_id: 'p-a',
    round: 1,
    position: 1,
    entry_a_id: 'entry-1',
    entry_b_id: 'entry-4',
  }),
]

describe('DrawPanel', () => {
  describe('an event whose draw is cut', () => {
    it('expands into its pools, in the event’s pool order', () => {
      page.render({ event: DRAWN })

      expect(page.getPoolHeading('Pool A')).toBeInTheDocument()
      expect(page.getPoolHeading('Pool B')).toBeInTheDocument()
      expect(page.queryEmptyState()).toBeNull()
    })

    /**
     * **Ten pools read 1 … 10, top to bottom** — the bug `Pool.position` was added to
     * kill, at the surface it was actually seen on.
     *
     * Pool ids used to be minted client-side (`genId('p')`), so a ten-pool event held
     * `p-1-…` … `p-10-…`; sorted as strings `p-10-` lands between `p-1-` and `p-2-` and
     * the draw rendered **1, 10, 2, 3 …**. The fixture hands the panel its pools in that
     * very order (`buildTenPools`), so the assertion reds for a panel that sorts by id
     * AND for one that merely renders whatever order it was handed. A nine-pool event
     * could not tell any of these apart — the two orders coincide below ten.
     */
    it('renders ten pools 1 … 10 — by position, not by id', () => {
      page.render({ event: buildTenPoolDrawnEvent() })

      expect(page.getPoolNames()).toEqual(TEN_POOLS_BY_POSITION)
      // Said the other way round too, because "not this" is the actual regression: the
      // wrong answer is a specific, recognisable sequence, not just "some other order".
      expect(page.getPoolNames()).not.toEqual(TEN_POOLS_BY_ID)
    })

    it('lists each pool’s entrants by name — the membership its fixtures imply', () => {
      page.render({ event: DRAWN })

      // The snake dealt 1/4/5 into Pool A and 2/3 into Pool B. Nothing on the wire says
      // so: it is derived from the fixtures (ADR-0786).
      expect(page.getPoolEntrants('Pool A')).toEqual([
        'player.1',
        'player.4',
        'player.5',
      ])
      expect(page.getPoolEntrants('Pool B')).toEqual(['player.2', 'player.3'])
    })

    it('renders every fixture as a named "A vs B" line, in round order, in its own pool', () => {
      page.render({ event: DRAWN })

      // NAMES, joined from the event's entrants by entry id — a panel that printed the
      // raw uuids would satisfy "some fixtures rendered" and be useless to a director.
      expect(page.getPoolLines('p-a')).toEqual([
        'player.1 vs player.4',
        'player.1 vs player.5',
        'player.4 vs player.5',
      ])
      expect(page.getPoolLines('p-b')).toEqual(['player.2 vs player.3'])
      // Grouped, not merely listed: each line sits inside the round it belongs to.
      expect(page.getRoundLines(1, 'Pool A')).toEqual(['player.1 vs player.4'])
      expect(page.getRoundLines(3, 'Pool A')).toEqual(['player.4 vs player.5'])
      expect(page.getRoundNames()).toEqual([
        'Round 1 fixtures in Pool A',
        'Round 2 fixtures in Pool A',
        'Round 3 fixtures in Pool A',
        'Round 1 fixtures in Pool B',
      ])
    })

    // An ODD pool (three players) plays three rounds of ONE fixture — the third player
    // sits each round out. A bye is the ABSENCE of a fixture (ADR-0786), so there is no
    // bye row and no fixture with an empty side.
    it('shows an odd pool’s bye as a missing fixture, not as a row', () => {
      page.render({ event: DRAWN })

      expect(page.getPoolLines('p-a')).toHaveLength(3)
      expect(page.getLineTexts().some((line) => /bye/i.test(line))).toBe(false)
    })

    it('renders a TBD side as TBD, not as a blank', () => {
      const withTbd = buildDrawnEvent({
        fixtures: [
          buildFixture({
            id: 'fx-a-1',
            poolId: 'p-a',
            round: 1,
            position: 1,
            entryAId: 'entry-1',
            entryBId: null,
          }),
        ],
      })

      page.render({ event: withTbd })

      expect(page.getPoolLines('p-a')).toEqual(['player.1 vs TBD'])
    })

    // The rule that must not break, whatever the routing does: a fixture is never dropped.
    // This event is a ROUND-ROBIN, so the fixture reaches the un-pooled group with no format
    // view that can place it — it is shown as itself (`'orphaned'`), which is the claim the
    // next describe block discriminates.
    it('keeps a fixture that belongs to no pool, rather than dropping it', () => {
      const withKo = buildDrawnEvent({
        fixtures: [
          buildFixture({
            id: 'fx-ko-1',
            poolId: null,
            round: 1,
            position: 1,
            entryAId: 'entry-1',
            entryBId: null,
          }),
        ],
      })

      page.render({ event: withKo })

      expect(page.queryOrphaned()).toBeInTheDocument()
      expect(page.getLineTexts()).toEqual(['player.1 vs TBD'])
    })
  })

  /**
   * **Which view the un-pooled fixtures get is the DRAW TYPE's answer** (`unpooledShape`,
   * `../../data/draw`) — the bug this suite exists to hold shut.
   *
   * Three draw types put fixtures in `unpooled`, and their payloads are indistinguishable
   * there: single-elim's whole bracket, `rr-then-ko`'s knockout stage, and every fixture of
   * a swiss draw all carry `pool_id: null`. The panel routed on that null, so swiss — a
   * pool-less draw *type* that merely shares it — rendered through single-elimination's
   * successor arithmetic, the one thing the ADR says swiss does not have.
   *
   * The type checker could never have caught it: the routing was a value check on a list's
   * length, not an exhaustive switch. It is one now, at both ends, and these are the tests
   * that say the switch sends each type somewhere different.
   */
  describe('which view the un-pooled fixtures get', () => {
    it('gives a SWISS draw the rounds view, and not the bracket', () => {
      page.render({ event: buildSwissDrawnEvent() })

      expect(page.querySwissRounds()).toBeInTheDocument()
      // The discriminating half: a swiss draw must not reach the bracket at all.
      expect(page.queryUnpooled()).toBeNull()
    })

    it('shows a swiss draw’s round 1 paired and its later rounds as forthcoming', () => {
      // Slice 2's demoable outcome, through the panel: the pairings a director reviews, and
      // the rounds that exist but have nobody in them yet — announced, not blank, not
      // hidden.
      page.render({ event: buildSwissDrawnEvent() })

      expect(page.swiss.getRoundHeadings()).toEqual([
        'Round 1',
        'Round 2',
        'Round 3',
      ])
      expect(page.swiss.getRoundLines(1)).toEqual([
        'player.1 vs player.4',
        'player.2 vs player.5',
        'player.3 vs player.6',
      ])
      expect(page.swiss.getForthcomingText(2)).toBe(
        '3 matches, paired once round 1 is decided.',
      )
    })

    // The regression pins. Both of these are un-pooled exactly as the swiss draw above is,
    // and both must still be brackets — for `rr-then-ko` the null genuinely IS the stage
    // discriminator, and that meaning is what the swiss fix must not disturb.
    it('still gives a SINGLE-ELIM draw the bracket', () => {
      page.render({ event: buildBracketDrawnEvent() })

      expect(page.queryUnpooled()).toBeInTheDocument()
      expect(page.querySwissRounds()).toBeNull()
      expect(page.getLineTexts()).toEqual([
        'player.1 vs player.4',
        'player.3 vs player.2',
        'TBD vs TBD',
      ])
    })

    /**
     * A ROUND-ROBIN fixture naming a pool the event does not list. It cannot be dropped
     * (that rule is pinned above), and it cannot be a bracket either: `Bracket` names its
     * rounds backwards from the last round present, so this one fixture rendered inside a
     * section headed **"Bracket"** with its round labelled **"Final"** — a knockout this
     * event does not have, a final nobody played. The arm answered `'bracket'` and an
     * exhaustive switch cannot see that a shape is a lie, so nothing was red.
     *
     * The assertion is three-sided on purpose: the fixture IS shown, it is NOT in the
     * bracket, and the words on screen are the neutral ones.
     */
    it('shows a ROUND-ROBIN’s unplaceable fixture as itself — not as a bracket final', () => {
      const strayPool = buildDrawnEvent({
        fixtures: [
          buildFixture({
            id: 'fx-orphan-1',
            // A pool id the event's `pools` does not list — the only way a round-robin
            // fixture reaches the un-pooled group at all.
            poolId: 'p-gone',
            round: 1,
            position: 1,
            entryAId: 'entry-1',
            entryBId: 'entry-4',
          }),
        ],
      })

      page.render({ event: strayPool })

      expect(page.getOrphaned()).toBeInTheDocument()
      expect(page.getLineTexts()).toEqual(['player.1 vs player.4'])
      // Not routed through knockout arithmetic: no bracket block, and the round keeps its
      // own number instead of being read back from a final.
      expect(page.queryUnpooled()).toBeNull()
      expect(page.getRoundNames()).toEqual(['Round 1 fixtures in other fixtures'])
    })

    it('still gives an RR-THEN-KO knockout stage the bracket, with its pools above it', () => {
      page.render({ event: buildTwoStageDrawnEvent() })

      expect(page.queryUnpooled()).toBeInTheDocument()
      expect(page.querySwissRounds()).toBeNull()
      // The pool stage is untouched by the routing change — it never went through
      // `unpooled` at all.
      expect(page.getPoolLines('p-a')).toEqual(['player.1 vs player.3'])
      expect(page.getPoolLines('p-b')).toEqual(['player.2 vs player.4'])
    })
  })

  describe('an event with no draw', () => {
    it('shows a designed empty state — never a spinner, never an error', () => {
      page.render({ event: buildEvent({ name: 'Open Singles' }) })

      expect(page.getEmptyState()).toHaveTextContent('No draw yet.')
      expect(page.queryNotice()).toBeNull()
      expect(page.getLines()).toHaveLength(0)
    })

    it('offers the director Generate — and neither of the drawn verbs', () => {
      page.render({ event: buildEvent({ name: 'Open Singles' }), canEdit: true })

      expect(page.queryGenerateButton('Open Singles')).toBeInTheDocument()
      expect(page.queryRecutButton('Open Singles')).toBeNull()
      expect(page.queryDeleteButton('Open Singles')).toBeNull()
    })

    // A player is not the director. They get the *fact* — the fixtures are not up — in
    // words written for them, and NO control: not a disabled Generate (an unexplained
    // dead end, ADR-0015), and not an imperative to press a button that isn't there.
    it('offers a non-owner nothing at all, and copy that does not tell them to generate one', () => {
      page.render({
        event: buildEvent({ id: 'ev-open-singles', name: 'Open Singles' }),
        canEdit: false,
      })

      expect(page.getEmptyState()).toHaveTextContent(
        'The fixtures will appear here once the director cuts the draw.',
      )
      expect(page.getEmptyState()).not.toHaveTextContent('Generate')
      expect(page.getPanelControls('ev-open-singles')).toHaveLength(0)
    })
  })

  describe('the owner’s verbs', () => {
    it('offers Re-cut and Delete on a draw that is already cut', () => {
      page.render({ event: DRAWN })

      expect(page.queryRecutButton('U1200 Singles')).toBeInTheDocument()
      expect(page.queryDeleteButton('U1200 Singles')).toBeInTheDocument()
      expect(page.queryGenerateButton('U1200 Singles')).toBeNull()
    })

    it('shows a NON-owner the cut draw and none of its verbs', () => {
      page.render({ event: DRAWN, canEdit: false })

      // The draw itself is not owner-only — the players in it may read it…
      expect(page.getPoolLines('p-a')).toHaveLength(3)
      // …and there is not one control anywhere in the panel.
      expect(page.getPanelControls('ev-u1200')).toHaveLength(0)
    })

    it('cuts the draw at that event’s draw resource', async () => {
      let seen: { url: string; method: string } | null = null
      mockEventCutDrawEndpoint(server, ({ request }) => {
        seen = { url: request.url, method: request.method }
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({
        tournamentId: 't-1',
        event: buildEvent({ id: 'ev-1', name: 'Open Singles' }),
      })

      await userEvent.click(await page.findGenerateButton('Open Singles'))

      await waitFor(() => expect(seen).not.toBeNull())
      expect(seen!.method).toBe('POST')
      expect(seen!.url).toContain('/v1/tournaments/t-1/events/ev-1/draw')
      // A clean cut says nothing: the refetched tournament is the answer.
      expect(page.queryNotice()).toBeNull()
    })

    it('re-cuts a standing draw through the same POST — once the confirm is answered', async () => {
      let seen = ''
      mockEventCutDrawEndpoint(server, ({ request }) => {
        seen = request.url
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))
      await userEvent.click(page.confirm.getConfirmButton())

      await waitFor(() =>
        expect(seen).toContain('/v1/tournaments/t-1/events/ev-u1200/draw'),
      )
    })

    it('deletes a draw with a DELETE on that same resource — once the confirm is answered', async () => {
      let seen: { url: string; method: string } | null = null
      mockEventUncutDrawEndpoint(server, ({ request }) => {
        seen = { url: request.url, method: request.method }
        return new HttpResponse(null, { status: 204 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findDeleteButton('U1200 Singles'))
      await userEvent.click(page.confirm.getConfirmButton())

      await waitFor(() => expect(seen).not.toBeNull())
      expect(seen!.method).toBe('DELETE')
      expect(seen!.url).toContain('/v1/tournaments/t-1/events/ev-u1200/draw')
    })

    // One whole-draw replacement at a time: a double-click must not race two cuts. The
    // confirm does NOT make this redundant — it asks a question once, per click, and two
    // clicks would ask it twice. The lock is what stops the second one being asked at all.
    it('locks the verbs while one is in flight', async () => {
      let calls = 0
      mockEventCutDrawEndpoint(server, async () => {
        calls += 1
        await delay('infinite')
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      const recut = await page.findRecutButton('U1200 Singles')
      await userEvent.click(recut)
      await userEvent.click(page.confirm.getConfirmButton())

      await waitFor(() => expect(recut).toBeDisabled())
      expect(page.queryDeleteButton('U1200 Singles')).toBeDisabled()
      await userEvent.click(recut)
      expect(calls).toBe(1)
      // …and the second click did not even get as far as the question: a locked verb
      // opens no dialog. Without this the assertion above would only be saying that a
      // disabled button is disabled, since the cut now needs a confirm it never got.
      expect(page.confirm.queryDialog()).toBeNull()
    })
  })

  /**
   * **The confirm is what fires the two destructive verbs** (ADR "a confirm prices an
   * irreversible act, a freeze explains an illegal one"). Re-cut and Delete each discard
   * a standing draw and the schedule solved on it, and neither is undoable — so the click
   * that names the act and the click that pays for it are different clicks.
   *
   * The first cut is exempt and stays a single click. That exemption is the reason the
   * other two are worth anything: a director trained to click through confirms reads none
   * of them.
   */
  describe('the confirm on a destructive verb', () => {
    /**
     * The endpoints **hang** (`delay('infinite')`) in these two, and that is what makes
     * them evidence rather than a race. A verb wired to the dialog *and* the mutation
     * would send a request that completes in milliseconds, and by the time an assertion
     * ran, `isPending` would be back to false and the panel would look untouched. A
     * request that never answers cannot settle away: it holds the verbs disabled for as
     * long as the test cares to look, so "both verbs are still live" is a synchronous
     * read of "nothing was sent" — one that does not depend on when MSW got there.
     */
    it('sends NOTHING on a bare click of Delete draw — the dialog is what gates it', async () => {
      let calls = 0
      mockEventUncutDrawEndpoint(server, async () => {
        calls += 1
        await delay('infinite')
        return new HttpResponse(null, { status: 204 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findDeleteButton('U1200 Singles'))

      // Settle on the dialog first — the count is only evidence once the click has been
      // given somewhere to have gone. Bounded under `testTimeout`, so a failure reads
      // "unable to find role=alertdialog" rather than an undiscriminated 5s timeout
      // (`web-client/CLAUDE.md`).
      await waitFor(() => expect(page.confirm.getDialog()).toBeInTheDocument(), {
        timeout: 2000,
      })
      expect(calls).toBe(0)
      // Swept by DOM: Radix marks everything behind an open modal `aria-hidden`, so a
      // role query finds none of the panel's buttons while the dialog is up.
      expect(enabledVerbsIn('ev-u1200')).toHaveLength(2)
    })

    it('sends NOTHING on a bare click of Re-cut draw either', async () => {
      let calls = 0
      mockEventCutDrawEndpoint(server, async () => {
        calls += 1
        await delay('infinite')
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))

      await waitFor(() => expect(page.confirm.getDialog()).toBeInTheDocument(), {
        timeout: 2000,
      })
      expect(calls).toBe(0)
      expect(enabledVerbsIn('ev-u1200')).toHaveLength(2)
    })

    // What the PANEL decides is which act opened and which event it carries — the tab
    // renders one card per event, so "the draw" alone is ambiguous the moment a
    // tournament has more than one. The sentences themselves belong to the dialog's own
    // test: pinning them here too is the shape that lets a copy edit green one file and
    // leave the other stale until a full-suite run. So each act is witnessed by ONE
    // string, the confirm button's — the words on the control the director actually
    // clicks — and that string still differs per variant, so a swapped act reds.
    it('names the act and the event it would discard', async () => {
      page.render({ event: DRAWN })

      await userEvent.click(await page.findDeleteButton('U1200 Singles'))

      expect(page.confirm.getDialog()).toHaveTextContent('U1200 Singles')
      expect(page.confirm.getConfirmButton()).toHaveTextContent('Delete the draw')
    })

    it('prices a re-cut as a re-deal, not as a deletion', async () => {
      page.render({ event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))

      expect(page.confirm.getConfirmButton()).toHaveTextContent('Re-cut the draw')
    })

    it('sends nothing when the director goes back, and leaves the draw standing', async () => {
      let calls = 0
      mockEventUncutDrawEndpoint(server, () => {
        calls += 1
        return new HttpResponse(null, { status: 204 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findDeleteButton('U1200 Singles'))
      await userEvent.click(page.confirm.getCancelButton())

      await waitFor(() => expect(page.confirm.queryDialog()).toBeNull())
      expect(calls).toBe(0)
      expect(page.getPoolLines('p-a')).toHaveLength(3)
      // A cancel is not a failure: there is nothing to explain, so there is no notice.
      expect(page.queryNotice()).toBeNull()
    })

    it('sends nothing when the dialog is dismissed with Escape', async () => {
      let calls = 0
      mockEventCutDrawEndpoint(server, () => {
        calls += 1
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))
      await userEvent.keyboard('{Escape}')

      await waitFor(() => expect(page.confirm.queryDialog()).toBeNull())
      expect(calls).toBe(0)
      expect(page.getPoolLines('p-a')).toHaveLength(3)
    })

    // The exemption, pinned. The first cut is constructive and re-cuttable: one click
    // cuts it, and no dialog stands in the way.
    it('asks nothing on the FIRST cut — Generate stays one click', async () => {
      let calls = 0
      mockEventCutDrawEndpoint(server, () => {
        calls += 1
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({
        tournamentId: 't-1',
        event: buildEvent({ id: 'ev-1', name: 'Open Singles' }),
      })

      await userEvent.click(await page.findGenerateButton('Open Singles'))

      await waitFor(() => expect(calls).toBe(1))
      expect(page.confirm.queryDialog()).toBeNull()
    })
  })

  /**
   * **A draw that is under way freezes both verbs** (#1060, ADR "a confirm prices an
   * irreversible act, a freeze explains an illegal one"). The server refuses a re-cut and
   * a delete with a 409 once any fixture has a winner or a match, and the client had gone
   * on offering both — a live button for an act that can only fail.
   *
   * Frozen means **present, dead and explained**, not hidden: hiding is ADR-0015's answer
   * to a *permission* boundary, and this director is entitled to the act and could have
   * performed it a minute ago.
   */
  describe('a draw that is already under way', () => {
    it('renders both verbs dead — and reachable, with the reason attached', () => {
      page.render({ event: PLAYED })

      const recut = page.queryRecutButton('U1200 Singles')
      const del = page.queryDeleteButton('U1200 Singles')

      // Present. A verb that vanished from under a director who could use it a minute ago
      // asks a loud question and answers none of it.
      expect(recut).toBeInTheDocument()
      expect(del).toBeInTheDocument()
      // Dead — and dead the way that keeps them **focusable**. `aria-disabled`, not the
      // `disabled` attribute: a disabled button leaves the tab order and most screen
      // readers skip it, so its description is a sentence nobody ever hears.
      expect(recut).toHaveAttribute('aria-disabled', 'true')
      expect(del).toHaveAttribute('aria-disabled', 'true')
      expect(recut).toBeEnabled()
      expect(del).toBeEnabled()
      // ⚠️ THE assertion of this slice, and the one #1223 is open against on the frozen
      // draw-type control: the reason reaches a screen reader THROUGH the control.
      // `toHaveAccessibleDescription` resolves the `aria-describedby` reference — an
      // assertion that merely compared ids would pass against a control pointing at
      // nothing, which is precisely the defect. ONE short token each: the sentence itself
      // belongs to `drawVerbFreeze`'s own test, and pinning it in two files is the shape
      // that greens one of them on a copy edit and leaves the other stale.
      expect(recut).toHaveAccessibleDescription(/under way/i)
      expect(del).toHaveAccessibleDescription(/under way/i)
      // …and it is on screen for a sighted director too — as a **status**, not an alert.
      // The `Alert` hardcodes `role="alert"` (assertive), which interrupts a screen reader
      // to announce a condition that was simply true when the page loaded. The refusal
      // below keeps `alert`; that one answers a click.
      const frozenNotice = page.getFrozenNotice('ev-u1200')
      expect(frozenNotice).toHaveTextContent('Re-cut and Delete are unavailable')
      expect(frozenNotice).toHaveAttribute('role', 'status')
    })

    /**
     * The **other half of the guard**, through the panel: a fixture that has merely
     * materialized — a linked `matchId`, no winner, nothing played. This is what go-live
     * produces on every ready fixture, so it is the commonest frozen draw there is, and
     * until now only the data module covered it.
     *
     * The control count is the load-bearing second assertion. This fixture's `matchStatus`
     * is `null`, so `matchOf` renders no "View match" `<Link>` — which is what keeps this
     * event usable in a panel test with no router, and what keeps the ADR-0015 sweep
     * (`INTERACTIVE_SELECTOR` matches an `a[href]`) counting verbs and nothing else.
     */
    it('freezes on a fixture that is a match but has no result yet', () => {
      page.render({ event: buildMaterializedDrawnEvent() })

      expect(page.queryRecutButton('U1200 Singles')).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      expect(page.queryDeleteButton('U1200 Singles')).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      expect(page.getFrozenNotice('ev-u1200')).toBeInTheDocument()
      // The two verbs, and no link: a materialized fixture with no status paints exactly
      // as an un-materialized one does.
      expect(page.getPanelControls('ev-u1200')).toHaveLength(2)
    })

    /**
     * The behaviour half, and a **second, independent witness** to the state assertions
     * above: a frozen verb opens no confirm and sends nothing.
     *
     * Two things make this evidence rather than a vacuous pass:
     *
     * - The identical click on an *unfrozen* event **does** open the dialog (the two
     *   "sends NOTHING on a bare click" tests above). So "no dialog" discriminates the
     *   freeze from the panel's ordinary behaviour, rather than describing a page where
     *   clicking does nothing anywhere.
     * - The click really **landed**. The frozen verb is styled dead but keeps its pointer
     *   events on purpose, so `userEvent.click` delivers it (it throws outright on a
     *   `pointer-events: none` target) and the button takes focus. Without that probe,
     *   "no dialog appeared" could not tell a working guard from a click swallowed by CSS.
     */
    it('opens no confirm and sends nothing when the frozen Re-cut is clicked', async () => {
      let calls = 0
      mockEventCutDrawEndpoint(server, async () => {
        calls += 1
        await delay('infinite')
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({ tournamentId: 't-1', event: PLAYED })

      const recut = await page.findRecutButton('U1200 Singles')
      await userEvent.click(recut)

      // The claim first, so a freeze that stopped working reds *as* "the confirm opened".
      expect(page.confirm.queryDialog()).toBeNull()
      // Then the probe that says the click was really delivered — read second so its
      // message only ever means what it says.
      expect(recut).toHaveFocus()
      expect(calls).toBe(0)
      // A refused click is not a failure to report: the notice slot stays empty and the
      // standing freeze notice is what does the talking.
      expect(page.queryNotice()).toBeNull()
    })

    it('opens no confirm and sends nothing when the frozen Delete is clicked', async () => {
      let calls = 0
      mockEventUncutDrawEndpoint(server, async () => {
        calls += 1
        await delay('infinite')
        return new HttpResponse(null, { status: 204 })
      })
      page.render({ tournamentId: 't-1', event: PLAYED })

      const del = await page.findDeleteButton('U1200 Singles')
      await userEvent.click(del)

      expect(page.confirm.queryDialog()).toBeNull()
      expect(del).toHaveFocus()
      expect(calls).toBe(0)
      expect(page.queryNotice()).toBeNull()
    })

    /**
     * ⚠️ **The freeze supersedes a standing refusal.** The race it settles is real and it
     * has one exit: the director clicks Re-cut on a draw nobody had played, the first score
     * lands first, the server answers 409, and the refetch the mutation settles into brings
     * back the evidence that freezes the verbs.
     *
     * Left alone, the two notices sit on the card **permanently**, saying nearly the same
     * thing in different words. `setNotice(null)` runs in exactly one place — the top of
     * `attempt` — and once frozen, `attempt` is unreachable: both destructive verbs
     * short-circuit before it, and Generate is not rendered on a drawn event. So the red
     * one has no way to clear, ever.
     *
     * A `rerenderWith` rather than a second `render`, because the claim is that the event
     * changed **underneath** a panel that is holding a refusal in its state — a fresh mount
     * would have no refusal to supersede and the test would pass against no fix at all.
     */
    it('drops a standing refusal once the freeze engages — one notice, not two', async () => {
      const playGuard =
        "This event's draw is already under way — at least one fixture has a match " +
        'or a recorded winner — so it can no longer be cut or removed.'
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail: playGuard }, { status: 409 }),
      )
      const { rerenderWith } = page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))
      await userEvent.click(page.confirm.getConfirmButton())
      // The refusal is up, on a draw that is still open — the two-notice state, mid-race.
      expect(await page.findNoticeText()).toContain(playGuard)
      expect(page.queryFrozenNotice('ev-u1200')).toBeNull()

      // …and now the refetch lands, carrying the score that beat the click.
      rerenderWith({ tournamentId: 't-1', event: PLAYED })

      expect(page.getFrozenNotice('ev-u1200')).toBeInTheDocument()
      // The whole assertion: the red one is gone, because no further request is possible
      // and a refusal nobody can retire is worse than none.
      expect(page.queryNotice()).toBeNull()
    })

    // The day-of re-cut ADR-0786 deliberately preserves. The freeze is on the EVIDENCE,
    // never on the draw existing — an over-eager predicate would take this away, and no
    // amount of correct freezing copy would make that right.
    it('leaves both verbs live on a cut draw nobody has played yet', () => {
      page.render({ event: DRAWN })

      expect(page.queryRecutButton('U1200 Singles')).not.toHaveAttribute(
        'aria-disabled',
      )
      expect(page.queryDeleteButton('U1200 Singles')).not.toHaveAttribute(
        'aria-disabled',
      )
      expect(page.queryFrozenNotice('ev-u1200')).toBeNull()
    })

    // Generate is untouched, and structurally so: an undrawn event has no fixtures, so it
    // has no evidence to find. Stated anyway, because "the freeze leaked onto the first
    // cut" is the one way this slice could break the exemption slice 1 exists to protect.
    it('does not freeze Generate on an undrawn event', async () => {
      let calls = 0
      mockEventCutDrawEndpoint(server, () => {
        calls += 1
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({
        tournamentId: 't-1',
        event: buildEvent({ id: 'ev-1', name: 'Open Singles' }),
      })

      const generate = await page.findGenerateButton('Open Singles')
      expect(generate).not.toHaveAttribute('aria-disabled')
      expect(page.queryFrozenNotice('ev-1')).toBeNull()

      await userEvent.click(generate)

      await waitFor(() => expect(calls).toBe(1))
    })

    /**
     * The non-owner branch is **unchanged by the freeze**: absent, not frozen.
     *
     * Two claims, and they are different. A reader gets no verbs at all — the ADR-0015
     * guard sweep still finds zero controls, which it would not if a frozen verb had been
     * rendered to them (`INTERACTIVE_SELECTOR` matches a `button` whatever its
     * `aria-disabled` says). And they get no freeze notice either: it explains two
     * controls they do not have, in the organizer's voice.
     */
    it('shows a NON-owner no verbs and no freeze — absent, not frozen', () => {
      page.render({ event: PLAYED, canEdit: false })

      expect(page.getPanelControls('ev-u1200')).toHaveLength(0)
      expect(page.queryFrozenNotice('ev-u1200')).toBeNull()
      // The draw itself is still theirs to read.
      expect(page.getPoolLines('p-a')).toHaveLength(3)
    })
  })

  // The refusals. Each is rendered INLINE, where the click happened — the draw verbs
  // carry no toast (`web-client/CLAUDE.md`, ## Forms) — and for the 409 and the 422 the
  // sentence beneath the title is the SERVER'S: it is written for the director and names
  // what they have to change. A generic string of ours would throw that away.
  describe('refusals', () => {
    const PLAY_GUARD =
      "This event's draw is already under way — at least one fixture has a match " +
      'or a recorded winner — so it can no longer be cut or removed.'

    it('explains the 409 play-guard on a re-cut, in the server’s words', async () => {
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail: PLAY_GUARD }, { status: 409 }),
      )
      page.render({ event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))
      await userEvent.click(page.confirm.getConfirmButton())

      const notice = await page.findNoticeText()
      expect(notice).toContain('This draw is already under way')
      expect(notice).toContain(PLAY_GUARD)
      // …and a screen reader is interrupted to hear it, because a refusal is an EVENT: it
      // lands in answer to this click. That is the half the freeze notice does not share —
      // it is a standing condition and carries `role="status"`. Asserted here because the
      // page object finds the notice by testid rather than by role (the freeze notice is
      // an `Alert` too, so "the alert" named neither of them). The role is still the
      // contract — this is where it is pinned.
      expect(await page.findNotice()).toHaveAttribute('role', 'alert')
      // The standing draw is untouched — a refused cut destroys nothing.
      expect(page.getPoolLines('p-a')).toHaveLength(3)
    })

    it('explains the 409 play-guard on a delete, too', async () => {
      mockEventUncutDrawEndpoint(server, () =>
        HttpResponse.json({ detail: PLAY_GUARD }, { status: 409 }),
      )
      page.render({ event: DRAWN })

      await userEvent.click(await page.findDeleteButton('U1200 Singles'))
      await userEvent.click(page.confirm.getConfirmButton())

      expect(await page.findNoticeText()).toContain(PLAY_GUARD)
    })

    /** The sample used to be "A single-elim draw cannot be cut yet." — a refusal the
     * server could still send when `DrawType` held five members and `strategy_for` had
     * a raise-arm. The enum now holds only what runs (ADR 20260726), so that sentence
     * is unreachable, while the behaviour under test (echo the server's own words
     * inline, no toast) is unchanged. The sample is a refusal single-elim really can
     * produce: a one-entrant bracket (`draws.py`). */
    it('shows the 422 for a bracket with nobody to play', async () => {
      const detail =
        'A single-elimination draw needs at least 2 entrants — a bracket of ' +
        'one has nobody to play.'
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail }, { status: 422 }),
      )
      page.render({
        event: buildEvent({
          id: 'ev-bracket',
          name: 'Championship Singles',
          drawType: 'single-elim',
          entrants: buildEntrants(1),
          // Un-pooled — a bracket has no pools (ADR-0786).
          pools: [],
        }),
      })

      await userEvent.click(await page.findGenerateButton('Championship Singles'))

      const notice = await page.findNoticeText()
      expect(notice).toContain("This event can't be drawn yet")
      expect(notice).toContain(detail)
    })

    it('shows the 422 for an event with no pools configured', async () => {
      const detail = 'A round-robin draw needs at least one pool.'
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail }, { status: 422 }),
      )
      page.render({
        event: buildEvent({
          id: 'ev-rr',
          name: 'U1500 Singles',
          drawType: 'round-robin',
          pools: [],
        }),
      })

      await userEvent.click(await page.findGenerateButton('U1500 Singles'))

      expect(await page.findNoticeText()).toContain(detail)
    })

    // The refusal whose NUMBERS are the whole message. No client-side string could carry
    // "5 entrants across 3 pool(s)", which is exactly why the server's sentence is shown
    // rather than a generic "this event can't be drawn".
    it('shows the 422 for pools that would leave someone with nobody to play — numbers and all', async () => {
      const detail =
        '5 entrants across 3 pool(s) would leave a pool with fewer than 2 entrants, ' +
        'who would have nobody to play.'
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail }, { status: 422 }),
      )
      page.render({
        event: buildEvent({
          id: 'ev-rr',
          name: 'U1500 Singles',
          drawType: 'round-robin',
          entrants: buildEntrants(5),
          pools: [
            buildPool({ id: 'p-1', name: 'Pool A', position: 0 }),
            buildPool({ id: 'p-2', name: 'Pool B', position: 1 }),
            buildPool({ id: 'p-3', name: 'Pool C', position: 2 }),
          ],
        }),
      })

      await userEvent.click(await page.findGenerateButton('U1500 Singles'))

      const notice = await page.findNoticeText()
      expect(notice).toContain('5 entrants across 3 pool(s)')
      expect(notice).toContain('nobody to play')
    })

    // No silent failures: the verbs carry no toast, so the panel must have words for the
    // failures that have no designed state of their own too.
    it('says something when the request never reaches the server', async () => {
      mockEventCutDrawEndpoint(server, () => HttpResponse.error())
      page.render({ event: buildEvent({ name: 'Open Singles' }) })

      await userEvent.click(await page.findGenerateButton('Open Singles'))

      const notice = await page.findNoticeText()
      expect(notice).toContain("Couldn't cut the draw")
    })

    it('clears the last refusal when the director tries again', async () => {
      let attempt = 0
      mockEventCutDrawEndpoint(server, () => {
        attempt += 1
        return attempt === 1
          ? HttpResponse.json(
              { detail: 'A round-robin draw needs at least one pool.' },
              { status: 422 },
            )
          : HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({
        event: buildEvent({
          id: 'ev-rr',
          name: 'U1500 Singles',
          drawType: 'round-robin',
          pools: [],
        }),
      })

      const generate = await page.findGenerateButton('U1500 Singles')
      await userEvent.click(generate)
      expect(await page.findNoticeText()).toContain('at least one pool')

      await userEvent.click(generate)

      await waitFor(() => expect(page.queryNotice()).toBeNull())
    })
  })

  /**
   * A refusal is a statement about a **moment** (#1123, #1049 repro B).
   *
   * The panel's notice used to be cleared only by the *next* Generate, and the card is
   * keyed by event id, so the panel does not remount when the event editor saves. A
   * director refused with "A single-elim draw cannot be cut yet. Change the event's draw
   * type to one that can" could therefore change the draw type to Round robin, save, and
   * still be reading the old sentence — a refusal about a state the event was no longer
   * in.
   *
   * Both halves are the design. It clears when the director fixes what it named, and it
   * survives everything else: the sentence names numbers they have to go and change, and
   * this page polls.
   */
  describe('a refusal does not outlive the state it describes', () => {
    const SINGLE_ELIM_REFUSAL =
      'A single-elim draw cannot be cut yet. Change the event’s draw type to one that ' +
      'can, or wait for support.'

    /** The event the refusal is about: a single-elim event the planner will not cut. */
    const BRACKET = buildEvent({
      id: 'ev-champs',
      name: 'Championship Singles',
      drawType: 'single-elim',
      entrants: buildEntrants(4),
      pools: [],
    })

    /** Get the 422 onto the screen, and hand back the render handle so the test can move
     * the event underneath it. */
    async function refusedCut() {
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail: SINGLE_ELIM_REFUSAL }, { status: 422 }),
      )
      const utils = page.render({ event: BRACKET })
      await userEvent.click(await page.findGenerateButton('Championship Singles'))
      expect(await page.findNoticeText()).toContain('cannot be cut yet')
      return utils
    }

    it('clears once the draw type changes to one that can be cut', async () => {
      const { rerenderWith } = await refusedCut()

      rerenderWith({
        event: { ...BRACKET, drawType: 'round-robin', pools: [buildPool({ id: 'p-a' })] },
      })

      expect(page.queryNotice()).toBeNull()
    })

    it('clears once somebody enters, for a refusal about the entrant count', async () => {
      const detail =
        '5 entrants across 3 pool(s) would leave a pool with fewer than 2 entrants.'
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail }, { status: 422 }),
      )
      const short = buildEvent({
        id: 'ev-rr',
        name: 'U1500 Singles',
        drawType: 'round-robin',
        entrants: buildEntrants(5),
        pools: [buildPool({ id: 'p-a' })],
      })
      const { rerenderWith } = page.render({ event: short })
      await userEvent.click(await page.findGenerateButton('U1500 Singles'))
      expect(await page.findNoticeText()).toContain('fewer than 2 entrants')

      // A sixth player enters. `entered` is the count the scope reads, and the factory
      // derives it from the list — so both move together, exactly as the server sends them.
      rerenderWith({
        event: { ...short, entered: 6, entrants: buildEntrants(6) },
      })

      expect(page.queryNotice()).toBeNull()
    })

    /**
     * The discriminating half. A blunt "clear whenever the event object changed" passes
     * both tests above, and then throws away the sentence a director is mid-way through
     * acting on the next time anything at all ticks. Here the event genuinely changes —
     * renamed, re-priced, a pool renamed — in ways no draw refusal asserts over.
     */
    it('keeps the refusal through a change it says nothing about', async () => {
      const { rerenderWith } = await refusedCut()

      rerenderWith({
        event: {
          ...BRACKET,
          name: 'Championship Singles (renamed)',
          entryFee: 45,
        },
      })

      expect(page.queryNotice()).not.toBeNull()
      expect(await page.findNoticeText()).toContain('cannot be cut yet')
    })

    it('keeps the refusal through a refetch that changed nothing', async () => {
      const { rerenderWith } = await refusedCut()

      rerenderWith({ event: { ...BRACKET } })

      expect(page.queryNotice()).not.toBeNull()
    })
  })

  /**
   * What a cut would actually produce, per draw type (#1220).
   *
   * The sentence was written for #786's round-robin and hard-coded, so it rendered on
   * every event whatever its type — unreachable on a bracket until single-elimination
   * became cuttable through the UI, and then plainly wrong: a director of a bracket event
   * was told to deal its entrants "into its pools".
   */
  describe('the empty state names what THIS draw type would cut', () => {
    it('does not promise pools to a bracket', () => {
      page.render({
        event: buildEvent({ name: 'Championship Singles', drawType: 'single-elim' }),
        canEdit: true,
      })

      expect(page.getEmptyState()).toHaveTextContent('bracket')
      expect(page.getEmptyState()).not.toHaveTextContent('pools')
    })

    it('does not promise pools — or a bracket — to a swiss event', () => {
      page.render({
        event: buildEvent({ name: 'Open Swiss', drawType: 'swiss' }),
        canEdit: true,
      })

      expect(page.getEmptyState()).toHaveTextContent('rounds')
      expect(page.getEmptyState()).not.toHaveTextContent('pools')
      expect(page.getEmptyState()).not.toHaveTextContent('bracket')
    })

    it('still names pools for a round-robin', () => {
      page.render({
        event: buildEvent({ name: 'U1500 Singles', drawType: 'round-robin' }),
        canEdit: true,
      })

      expect(page.getEmptyState()).toHaveTextContent('pools')
    })

    it('names both stages for an rr-then-ko event', () => {
      page.render({
        event: buildEvent({
          name: 'Open Singles',
          drawType: 'rr-then-ko',
          qualifiersPerPool: 2,
        }),
        canEdit: true,
      })

      expect(page.getEmptyState()).toHaveTextContent('pools')
      expect(page.getEmptyState()).toHaveTextContent('bracket')
    })

    /** A reader is told the same thing whatever the draw type: the fixtures are not up
     * yet. Naming the format would only tell a player something they cannot act on. */
    it('tells a non-owner the same thing whatever the draw type', () => {
      page.render({
        event: buildEvent({ name: 'Championship Singles', drawType: 'single-elim' }),
        canEdit: false,
      })

      expect(page.getEmptyState()).toHaveTextContent(
        'The fixtures will appear here once the director cuts the draw.',
      )
    })
  })
})
