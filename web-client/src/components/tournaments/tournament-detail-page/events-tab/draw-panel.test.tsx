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
  buildDrawnEvent,
  buildEntrants,
  buildEvent,
  buildFixture,
  buildPool,
} from '../../data/seed.factory'
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

describe('DrawPanel', () => {
  describe('an event whose draw is cut', () => {
    it('expands into its pools, in the event’s pool order', () => {
      page.render({ event: DRAWN })

      expect(page.getPoolHeading('Pool A')).toBeInTheDocument()
      expect(page.getPoolHeading('Pool B')).toBeInTheDocument()
      expect(page.queryEmptyState()).toBeNull()
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

      expect(page.queryUnpooled()).toBeInTheDocument()
      expect(page.getLineTexts()).toEqual(['player.1 vs TBD'])
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
    const PLAY_GUARD =
      "This event's draw is already under way — at least one fixture has a match " +
      'or a recorded winner — so it can no longer be cut or removed.'

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

    it('shows the 422 for a draw type nothing can cut yet', async () => {
      const detail =
        'A single-elim draw cannot be cut yet. ' +
        "Change the event's draw type to one that can, or wait for support."
      mockEventCutDrawEndpoint(server, () =>
        HttpResponse.json({ detail }, { status: 422 }),
      )
      page.render({
        event: buildEvent({
          id: 'ev-bracket',
          name: 'Championship Singles',
          drawType: 'single-elim',
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
            buildPool({ id: 'p-1', name: 'Pool A' }),
            buildPool({ id: 'p-2', name: 'Pool B' }),
            buildPool({ id: 'p-3', name: 'Pool C' }),
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
})
