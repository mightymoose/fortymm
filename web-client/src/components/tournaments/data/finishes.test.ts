import { WITHDRAWN_LABEL } from './draw'
import { eventFinishes } from './finishes'
import {
  buildEntrants,
  buildEvent,
  buildFinishesEvent,
  buildFinishesResults,
  buildFinishRow,
  buildStandingsEvent,
} from './seed.factory'

describe('eventFinishes', () => {
  it('returns null for an event with no results', () => {
    expect(eventFinishes(buildEvent())).toBeNull()
  })

  it('returns null for a standings (round-robin) event — the wrong arm', () => {
    // The finishes view owns only the `finishes` arm of the union; a `standings` result is
    // `./standings`' job, and this renders nothing off it.
    expect(eventFinishes(buildStandingsEvent())).toBeNull()
  })

  it('joins each finish’s entry id to a username, in the server’s order', () => {
    const view = eventFinishes(buildFinishesEvent())

    expect(view?.finishes.map((f) => f.name)).toEqual([
      'player.1',
      'player.2',
      'player.3',
      'player.4',
    ])
  })

  it('labels a solely-held position as an ordinal and marks it untied', () => {
    const view = eventFinishes(buildFinishesEvent())

    const champ = view?.finishes[0]
    const runnerUp = view?.finishes[1]
    expect(champ?.positionLabel).toBe('1st')
    expect(champ?.tied).toBe(false)
    expect(champ?.isChampion).toBe(true)
    expect(runnerUp?.positionLabel).toBe('2nd')
    expect(runnerUp?.tied).toBe(false)
    expect(runnerUp?.isChampion).toBe(false)
  })

  it('marks same-position finishes as a tie and labels them T{n}', () => {
    // The two semifinal losers share position 3 — single-elimination does not rank them
    // against each other, so the view renders a tie rather than inventing an order.
    const view = eventFinishes(buildFinishesEvent())

    const thirds = view?.finishes.filter((f) => f.position === 3) ?? []
    expect(thirds).toHaveLength(2)
    expect(thirds.every((f) => f.tied)).toBe(true)
    expect(thirds.every((f) => f.positionLabel === 'T3')).toBe(true)
  })

  it('carries the server’s finishes order through untouched', () => {
    // The order IS the result (ADR-0785). Feed the finishes out of position order and expect
    // them back in that same order.
    const view = eventFinishes(
      buildFinishesEvent({
        results: buildFinishesResults({
          finishes: [
            buildFinishRow({ entryId: 'entry-3', position: 3, eliminatedInRound: 1 }),
            buildFinishRow({ entryId: 'entry-1', position: 1, eliminatedInRound: null }),
          ],
          champion: 'entry-1',
        }),
      }),
    )

    expect(view?.finishes.map((f) => f.entryId)).toEqual(['entry-3', 'entry-1'])
  })

  it('shows a partial (live) bracket’s finishes so far, with no champion', () => {
    // A half-played bracket sends only the entrants eliminated so far; nobody is champion
    // yet. The view renders whatever the server sent — it never computes a placement.
    const view = eventFinishes(
      buildFinishesEvent({
        results: buildFinishesResults({
          complete: false,
          champion: null,
          finishes: [
            buildFinishRow({ entryId: 'entry-3', position: 3, eliminatedInRound: 1 }),
            buildFinishRow({ entryId: 'entry-4', position: 3, eliminatedInRound: 1 }),
          ],
        }),
      }),
    )

    expect(view?.complete).toBe(false)
    expect(view?.champion).toBeNull()
    expect(view?.finishes.map((f) => f.name)).toEqual(['player.3', 'player.4'])
    // Both alive-until-now losers tie 3rd; the two finalists have no finish yet — absent.
    expect(view?.finishes.every((f) => f.positionLabel === 'T3')).toBe(true)
  })

  it('joins the champion to a name', () => {
    const view = eventFinishes(buildFinishesEvent())

    expect(view?.complete).toBe(true)
    expect(view?.champion).toBe('player.1')
  })

  it('shows a finish naming a no-longer-listed entry as Withdrawn', () => {
    // A placed player who withdrew afterward: no username to join, so the word, never a
    // blank and never the raw id.
    const view = eventFinishes(
      buildFinishesEvent({
        entrants: buildEntrants(3), // entry-4 is gone
        results: buildFinishesResults({
          finishes: [
            buildFinishRow({ entryId: 'entry-4', position: 3, eliminatedInRound: 1 }),
          ],
        }),
      }),
    )

    expect(view?.finishes[0].name).toBe(WITHDRAWN_LABEL)
  })
})
