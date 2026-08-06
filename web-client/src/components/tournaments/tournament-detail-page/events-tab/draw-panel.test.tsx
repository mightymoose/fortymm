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
  buildPool,
  buildSwissDrawnEvent,
  buildSwissEvent,
  buildTenPoolDrawnEvent,
  buildTwoStageDrawnEvent,
  TEN_POOLS_BY_ID,
  TEN_POOLS_BY_POSITION,
} from '../../data/seed.factory'
import {
  buildCrowdedPoolsEvent,
  buildEmptyFieldEvent,
  buildLoneBracketEvent,
  buildUnderWayEvent,
} from './draw-panel.factory'
import { drawPanelPage as page } from './draw-panel.page'

/** The seeded drawn event: round-robin, `player.1`…`player.5`, Pool A (1/4/5 — odd) and
 * Pool B (2/3). */
const DRAWN = buildDrawnEvent()

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

/** The server's own sentences, hard-coded test-side rather than imported from the code
 * under test: a test that read the copy from the thing it is testing would pass whatever
 * the copy became. */
const PLAY_GUARD =
  "This event's draw is already under way — at least one fixture has a match " +
  'or a recorded winner — so it can no longer be cut or removed.'
const LONE_BRACKET =
  'A single-elimination draw needs at least 2 entrants — a bracket of one has ' +
  'nobody to play.'
const EMPTY_FIELD =
  '0 entrants across 2 pool(s) would leave a pool with fewer than 2 entrants, ' +
  'who would have nobody to play.'
const CROWDED_POOLS =
  '5 entrants across 3 pool(s) would leave a pool with fewer than 2 entrants, ' +
  'who would have nobody to play.'

/** The cut endpoint, refusing with `status` and the server's own `detail` — the shape
 * every refusal below arrives in (FastAPI's `{"detail": "…"}`). */
function refuseCut(status: number, detail: string) {
  mockEventCutDrawEndpoint(server, () =>
    HttpResponse.json({ detail }, { status }),
  )
}

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

    it('re-cuts a standing draw through the same POST', async () => {
      let seen = ''
      mockEventCutDrawEndpoint(server, ({ request }) => {
        seen = request.url
        return HttpResponse.json(cutResponse(), { status: 201 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))

      await waitFor(() =>
        expect(seen).toContain('/v1/tournaments/t-1/events/ev-u1200/draw'),
      )
    })

    it('deletes a draw with a DELETE on that same resource', async () => {
      let seen: { url: string; method: string } | null = null
      mockEventUncutDrawEndpoint(server, ({ request }) => {
        seen = { url: request.url, method: request.method }
        return new HttpResponse(null, { status: 204 })
      })
      page.render({ tournamentId: 't-1', event: DRAWN })

      await userEvent.click(await page.findDeleteButton('U1200 Singles'))

      await waitFor(() => expect(seen).not.toBeNull())
      expect(seen!.method).toBe('DELETE')
      expect(seen!.url).toContain('/v1/tournaments/t-1/events/ev-u1200/draw')
    })

    // One whole-draw replacement at a time: a double-click must not race two cuts.
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

      await waitFor(() => expect(recut).toBeDisabled())
      expect(page.queryDeleteButton('U1200 Singles')).toBeDisabled()
      await userEvent.click(recut)
      expect(calls).toBe(1)
    })
  })

  // The refusals. Each is rendered INLINE, where the click happened — the draw verbs
  // carry no toast (`web-client/CLAUDE.md`, ## Forms) — and for the 409 and the 422 the
  // sentence beneath the title is the SERVER'S: it is written for the director and names
  // what they have to change. A generic string of ours would throw that away.
  describe('refusals', () => {
    it('explains the 409 play-guard on a re-cut, in the server’s words', async () => {
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail: PLAY_GUARD }, { status: 409 }),
      )
      page.render({ event: DRAWN })

      await userEvent.click(await page.findRecutButton('U1200 Singles'))

      const notice = await page.findNoticeText()
      expect(notice).toContain('This draw is already under way')
      expect(notice).toContain(PLAY_GUARD)
      // The standing draw is untouched — a refused cut destroys nothing.
      expect(page.getPoolLines('p-a')).toHaveLength(3)
    })

    it('explains the 409 play-guard on a delete, too', async () => {
      mockEventUncutDrawEndpoint(server, () =>
        HttpResponse.json({ detail: PLAY_GUARD }, { status: 409 }),
      )
      page.render({ event: DRAWN })

      await userEvent.click(await page.findDeleteButton('U1200 Singles'))

      expect(await page.findNoticeText()).toContain(PLAY_GUARD)
    })

    /** The sample used to be "A single-elim draw cannot be cut yet." — a refusal the
     * server could still send when `DrawType` held five members and `strategy_for` had
     * a raise-arm. The enum now holds only what runs (ADR 20260726), so that sentence
     * is unreachable, while the behaviour under test (echo the server's own words
     * inline, no toast) is unchanged. The sample is a refusal single-elim really can
     * produce: a one-entrant bracket (`draws.py`). */
    it('shows the 422 for a bracket with nobody to play', async () => {
      refuseCut(422, LONE_BRACKET)
      page.render({ event: buildLoneBracketEvent() })

      await userEvent.click(await page.findGenerateButton('Championship Singles'))

      const notice = await page.findNoticeText()
      expect(notice).toContain("This event can't be drawn yet")
      expect(notice).toContain(LONE_BRACKET)
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
      refuseCut(422, CROWDED_POOLS)
      page.render({ event: buildCrowdedPoolsEvent() })

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
})

// **A refusal expires** (`CONTEXT.md`, "Refusal"): it is a statement about a moment, and
// it stops being true the instant the state it describes changes. Nobody clicks anything
// in these tests after the first attempt — the event simply arrives again, as it does on
// every mutation's settle and on every edit the director makes elsewhere on the page —
// and the sentence either withdraws itself or stays.
describe('DrawPanel · a refusal outlives its state only until the state moves', () => {
  // #1123, as reported: a refusal that names the draw type, and a director who changes
  // the draw type. Only the type moves here — not the pools, not the field — so this
  // reds against a fingerprint that forgot it, rather than passing on some other part's
  // coat-tails.
  it('withdraws the bracket refusal when the draw type changes — with no second click', async () => {
    refuseCut(422, LONE_BRACKET)
    const { rerender } = page.render({ event: buildLoneBracketEvent() })
    await userEvent.click(await page.findGenerateButton('Championship Singles'))
    expect(await page.findNoticeText()).toContain('single-elimination draw needs')

    // The director changes the type to round robin; the page refetches and re-renders.
    rerender({ event: buildLoneBracketEvent({ drawType: 'round-robin' }) })

    expect(page.queryNotice()).toBeNull()
    // The affordance is untouched — the refusal went, the button it was about did not.
    expect(page.queryGenerateButton('Championship Singles')).toBeInTheDocument()
  })

  // The same rule, for the draw type swiss brought with it (#1284). A swiss cut refuses a
  // round count below one, and R is a number the director goes and fixes — so R has to be
  // in the fingerprint or the refusal outlives the fix. This is #1123 for the new type:
  // it would pass against a fingerprint that omits `rounds` ONLY if the notice never
  // expired at all, which the sibling tests already rule out.
  it('withdraws a swiss refusal when the round count changes — with no second click', async () => {
    const ROUNDS_FLOOR = 'rounds must be at least 1, got 0.'
    refuseCut(422, ROUNDS_FLOOR)
    const { rerender } = page.render({
      event: buildSwissEvent({ name: 'Swiss Open', rounds: 0 }),
    })
    await userEvent.click(await page.findGenerateButton('Swiss Open'))
    expect(await page.findNoticeText()).toContain('rounds must be at least 1')

    // The director sets a legal round count; the page refetches and re-renders.
    rerender({ event: buildSwissEvent({ name: 'Swiss Open', rounds: 5 }) })

    expect(page.queryNotice()).toBeNull()
    expect(page.queryGenerateButton('Swiss Open')).toBeInTheDocument()
  })

  // #1049 Repro B: "0 entrants across 2 pool(s)…" above a panel whose event now has an
  // entrant. The pools and the type are held still, so the entrant count is the only
  // thing that can be carrying this one.
  it('withdraws the empty-field refusal when a player enters — with no second click', async () => {
    refuseCut(422, EMPTY_FIELD)
    const { rerender } = page.render({ event: buildEmptyFieldEvent() })
    await userEvent.click(await page.findGenerateButton('U1500 Singles'))
    expect(await page.findNoticeText()).toContain('0 entrants across 2 pool(s)')

    rerender({ event: buildEmptyFieldEvent({ entrants: buildEntrants(1) }) })

    expect(page.queryNotice()).toBeNull()
  })

  // The other direction, and the more expensive mistake: the refusal names what the
  // director has to go and change, and they are reading it *while* going to change it. An
  // edit to something it does not turn on must leave it exactly where it is — a rule that
  // cleared on any fresh event would take the sentence away mid-fix (ADR-0786).
  it('keeps a still-true refusal when something it does not turn on changes', async () => {
    refuseCut(422, CROWDED_POOLS)
    const { rerender } = page.render({ event: buildCrowdedPoolsEvent() })
    await userEvent.click(await page.findGenerateButton('U1500 Singles'))
    await page.findNotice()

    // The director renames the event, renames a pool and gives it tables, and raises the
    // cap — none of which the planner reads. Still five entrants, still three pools.
    rerender({
      event: buildCrowdedPoolsEvent({
        name: 'U1500 Singles (Sunday)',
        maxPlayers: 32,
        pools: [
          buildPool({ id: 'p-1', name: 'Pool A', tableIds: ['t-1', 't-2'] }),
          buildPool({ id: 'p-2', name: 'Pool Blue' }),
          buildPool({ id: 'p-3', name: 'Pool C' }),
        ],
      }),
    })

    // Synchronously: the refusal was already on screen, so there is nothing to wait for,
    // and expiry is decided in the same render that sees the new data.
    expect(page.queryNoticeText()).toContain('5 entrants across 3 pool(s)')
  })

  // The 409 is *about* a state change, so the state it is about must NOT expire it: the
  // click that earns it reconciles the tournament (the draw mutations refetch on settle,
  // failure path included), which is exactly when the fixtures carrying a match and a
  // winner land. A fingerprint built on the fixtures would delete this sentence in the
  // same beat it appeared, and the director would watch the panel refuse their Delete
  // draw for no stated reason.
  it('keeps the play-guard refusal when the evidence of play it names arrives', async () => {
    mockEventUncutDrawEndpoint(server, () =>
      HttpResponse.json({ detail: PLAY_GUARD }, { status: 409 }),
    )
    const { rerender } = page.render({ event: DRAWN })
    await userEvent.click(await page.findDeleteButton('U1200 Singles'))
    await page.findNotice()

    // The refetch lands: the first fixture is now a completed match with a winner — the
    // very thing the refusal says it cannot delete around.
    rerender({ event: buildUnderWayEvent() })

    expect(page.queryNoticeText()).toContain(PLAY_GUARD)
  })
})
