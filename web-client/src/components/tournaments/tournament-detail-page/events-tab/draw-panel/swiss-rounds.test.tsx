import {
  buildEntrants,
  buildSwissDrawnEvent,
  buildSwissOddDrawnEvent,
  buildSwissOddMidEvent,
} from '../../../data/seed.factory'
import { buildFixtureLineView } from './round-list/fixture-line.factory'
import {
  buildMidSwissRounds,
  buildSwissRoundsPropsFor,
} from './swiss-rounds.factory'
import { swissRoundsPage as page } from './swiss-rounds.page'

describe('SwissRounds', () => {
  it('shows every cut round, in order — the forthcoming ones included', async () => {
    // All `R` rounds exist from the cut (ADR "swiss pre-cuts every round and pairs each one
    // on advance"), and the round count is the setting the director chose, so hiding the
    // unpaired ones would hide the length of the day they booked a venue for.
    page.render()
    await page.findRound(1)

    expect(page.getRoundHeadings()).toEqual(['Round 1', 'Round 2', 'Round 3'])
  })

  it('renders round 1’s pairings, seeded from the draw order', async () => {
    page.render()
    await page.findRound(1)

    expect(page.getRoundLines(1)).toEqual([
      'player.1 vs player.4',
      'player.2 vs player.5',
      'player.3 vs player.6',
    ])
  })

  /**
   * The claim the whole component is for: an unpaired round is announced, not drawn as
   * `⌊n/2⌋` identical "TBD vs TBD" rows — which is honest, unreadable, and reads as a bug —
   * and not hidden either.
   */
  it('announces an unpaired round instead of listing TBD against TBD', async () => {
    page.render()
    await page.findRound(1)

    expect(page.queryRound(2)).toBeNull()
    expect(page.getForthcomingText(2)).toBe(
      '3 matches, paired once round 1 is decided.',
    )
    expect(page.getForthcomingText(3)).toBe(
      '3 matches, paired once round 2 is decided.',
    )
  })

  it('says which round each forthcoming one waits on — never all on round 1', async () => {
    // Round 3 waits on round 2, not on round 1. A component that hardcoded "round 1", or
    // that read the FIRST round rather than the previous one, passes the round-2 case and
    // fails here.
    page.render()
    await page.findRound(1)

    expect(page.getForthcomingText(3)).toContain('round 2')
    expect(page.getForthcomingText(3)).not.toContain('round 1')
  })

  /**
   * ⚠️ **The discriminating case.** On a freshly-cut draw "is this round paired?" and "is
   * this round 1?" give the same answer for every round, so a component keyed off the round
   * NUMBER passes every test above. Here they disagree: round 2 has been paired by
   * `advance()` from the standings and must render its real fixtures, while round 3 is
   * still forthcoming.
   *
   * This is not a contrived state — it is what a running swiss event looks like for most of
   * its life. A number-keyed renderer would show a live, playable round 2 as "not paired
   * yet" for the rest of the tournament.
   */
  it('renders a LATER round that advance() has paired, and still waits on the rest', async () => {
    page.render({ rounds: buildMidSwissRounds() })
    await page.findRound(1)

    expect(page.getRoundLines(2)).toEqual([
      'player.1 vs player.2',
      'player.3 vs player.4',
      'player.5 vs player.6',
    ])
    // …and the round after it is still forthcoming, so this is "the predicate follows the
    // sides" rather than "everything renders as paired now".
    expect(page.queryRound(3)).toBeNull()
    expect(page.queryForthcoming(3)).not.toBeNull()
    // Round 2 is paired, so it is NOT also announced as forthcoming.
    expect(page.queryForthcoming(2)).toBeNull()
  })

  it('inflects a one-match round', async () => {
    // A two-entrant swiss: one pairing a round, so the noun is singular. The count comes
    // off the fixtures, so a hardcoded plural is wrong for the smallest real field.
    page.render({
      rounds: [
        {
          round: 1,
          fixtures: [
            buildFixtureLineView({ id: 'fx-r1', position: 1 }),
          ],
        },
        {
          round: 2,
          fixtures: [
            buildFixtureLineView({
              id: 'fx-r2',
              position: 1,
              a: { kind: 'tbd' },
              b: { kind: 'tbd' },
            }),
          ],
        },
      ],
    })
    await page.findRound(1)

    expect(page.getForthcomingText(2)).toBe(
      '1 match, paired once round 1 is decided.',
    )
  })

  /** A withdrawn side means the entry was *seated* and has since left — the draw is stale,
   * which is a thing to show. Treating it as unpaired would replace a real pairing with
   * "forthcoming" and hide the staleness. */
  it('treats a round with a withdrawn side as paired, not forthcoming', async () => {
    page.render({
      rounds: [
        {
          round: 1,
          fixtures: [
            buildFixtureLineView({
              id: 'fx-stale',
              position: 1,
              a: { kind: 'withdrawn' },
              b: { kind: 'tbd' },
            }),
          ],
        },
      ],
    })
    await page.findRound(1)

    expect(page.getRoundLines(1)).toEqual(['Withdrawn vs TBD'])
    expect(page.queryForthcoming(1)).toBeNull()
  })

  /**
   * The bye. A seven-entrant event plays `⌊7/2⌋ = 3` pairings a round and the seventh
   * entrant appears in **no fixture**, because a bye is the absence of a row (ADR-0786).
   * Before this line they were nowhere in the draw at all: on screen in Standings, absent
   * from the pairings, and a director could only work out who was sitting out by diffing
   * the two lists by hand.
   */
  describe('the entrant sitting out an odd round', () => {
    it('names them, as a line of the round they sit out', async () => {
      page.render(buildSwissRoundsPropsFor(buildSwissOddDrawnEvent()))
      await page.findRound(1)

      // Six of the seven are paired…
      expect(page.getRoundLines(1)).toEqual([
        'player.1 vs player.4',
        'player.2 vs player.5',
        'player.3 vs player.6',
      ])
      // …and the seventh is named, in the round, rather than left for the director to
      // work out. No record and no win: a bye scores nothing here.
      expect(page.getByeText(1)).toBe('Bye: player.7')
    })

    /**
     * ⚠️ **The discriminating case.** On the freshly-cut draw above only round 1 is paired,
     * so "who sits out THIS round" and "who sits out round 1" give the same answer — an
     * implementation that subtracted against the first round's fixtures for every round
     * passes it. Here they disagree: `advance()` has paired round 2, byeing `entry-1` (who
     * won round 1) while `entry-7` — round 1's bye — plays.
     */
    it('follows the round, not the first one: a later round byes somebody else', async () => {
      page.render(buildSwissRoundsPropsFor(buildSwissOddMidEvent()))
      await page.findRound(1)

      expect(page.getByeText(1)).toBe('Bye: player.7')
      expect(page.getRoundLines(2)).toEqual([
        'player.2 vs player.3',
        'player.4 vs player.5',
        'player.6 vs player.7',
      ])
      expect(page.getByeText(2)).toBe('Bye: player.1')
    })

    /**
     * A round nobody has been paired in yet byes **nobody** — and this is the case that
     * separates a real derivation from a set subtraction fired at every round. Round 3 of
     * this draw is cut with both sides null, so *every* one of the seven entrants is "in no
     * fixture of round 3": an ungated implementation announces the whole field as sitting
     * out a round the event has not reached.
     */
    it('names nobody under a round that is not paired yet', async () => {
      page.render(buildSwissRoundsPropsFor(buildSwissOddDrawnEvent()))
      await page.findRound(1)

      expect(page.queryForthcoming(3)).not.toBeNull()
      expect(page.queryBye(2)).toBeNull()
      expect(page.queryBye(3)).toBeNull()
    })

    /**
     * An **even** field byes nobody, so there is no line — a "nobody sits out" note on
     * every round of every even event is noise.
     *
     * The fixture is deliberately not the tidy six-over-six cut: eight entrants over a
     * six-seat round, which is what a draw looks like after two more players enter (a
     * *stale* draw, which the panel still renders). So two entrants really are seated in no
     * fixture, and the claim under test is the **parity** gate rather than an empty
     * subtraction that could not have failed.
     */
    it('names nobody when the field is even, even with entrants left unseated', async () => {
      page.render(
        buildSwissRoundsPropsFor(
          buildSwissDrawnEvent({ entrants: buildEntrants(8) }),
        ),
      )
      await page.findRound(1)

      expect(page.getRoundLines(1)).toEqual([
        'player.1 vs player.4',
        'player.2 vs player.5',
        'player.3 vs player.6',
      ])
      expect(page.queryBye(1)).toBeNull()
    })
  })
})
