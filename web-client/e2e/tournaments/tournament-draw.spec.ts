/**
 * The **draw** (ADR-0786), through the real browser: cutting one, re-cutting it, throwing
 * it away — and the three refusals that guard it.
 *
 * A draw is the set of **fixtures** an event's draw type prescribes. A fixture is a
 * *planned pairing* (round + position, plus a pool when the draw is pooled) and it is
 * NOT a match. A draw is **current** when its fixtures seat exactly the event's active
 * entrants; an entry *or a withdrawal* after the cut makes it **stale**, and go-live
 * refuses a stale one.
 *
 * What only a browser can prove here, and why none of it was settled by the vitest suite:
 *
 *   1. **The scaffold renders as a draw, not as data.** `drawState` is unit-tested to
 *      death, but nothing below the browser had ever *cut* a draw and then read the
 *      result off the page: the pools, their membership (which nothing stores — it is
 *      derived from the fixtures), the rounds, and the **named** "A vs B" lines. The
 *      names are the point: a fixture carries entry *ids*, and the usernames are joined
 *      on at render.
 *
 *   2. **The stub can no longer wave a bad start through.** Until this spec, the e2e
 *      store built every event with `fixtures: []` and accepted `published → live`
 *      *unconditionally* — so no browser spec could reach a drawn state at all, and the
 *      go-live precondition the server enforces was unexercised. A stub more permissive
 *      than the server lets us ship a UI that lies: a Start button that works in every
 *      test we own and 409s in front of a director on the morning of their tournament.
 *
 *   3. **The refusals reach a human, inline.** The draw panel's mutations carry no toast
 *      (`web-client/CLAUDE.md`, ## Forms — a surface that reports inline must not also
 *      toast), so the `Alert` beside the button IS the error surface. And for the 409 and
 *      the 422 the server's sentence is the copy, because it names the thing the director
 *      has to change.
 *
 *   4. **The editor's freeze is real, and is not a wholesale grey-out.** With a draw
 *      standing, the pool *set* and the draw *type* are refused (with the reason, and the
 *      way out) — while a pool's tables stay editable, which is the case the freeze
 *      exists to permit. A section that greyed itself out entirely would pass a test that
 *      only checked Add and Remove.
 *
 *   5. **axe-clean in every new state** — the drawn scaffold, the refusal notices, and
 *      the frozen editor. Contrast, focus and hidden-focusable are unrepresentable in
 *      jsdom, and `aria-describedby` on a *disabled* control is the only channel it has.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import {
  EVENT,
  ME,
  READY_TO_START,
} from '../page-objects/tournaments/tournaments-store'
import { expectAxeClean } from '../support/axe'

/** The panel's copy, hard-coded test-side (as the lifecycle spec's notices are):
 * importing it from `data/draw` would make every assertion below pass whatever the copy
 * became. */
const SAY = {
  /** The designed empty state — an event with no draw. */
  noDraw: 'No draw yet.',
  /** The title over a refused *cut*; the sentence beneath it is the server's. */
  cannotDraw: "This event can't be drawn yet",
  /** …and the server's sentence, verbatim, for the refusal this suite drives: a
   * round-robin with no pools has nowhere to deal its field.
   *
   * Deliberately NOT "A <type> draw cannot be cut yet" — every member of `DrawType` now
   * has a strategy behind it (ADR 20260726), so a stub that answered with that sentence
   * would be putting words in the server's mouth that it can no longer say. This one it
   * emits for real, and permanently. */
  noPools: 'A round-robin draw needs at least one pool.',
  /** The bracket's twin of the sentence above: a single-elimination event whose field is
   * one player. Also permanent, and also about the event's *configuration* rather than
   * about its type — which, since the enum shrank, is the only kind of 422 a cut has
   * left. */
  loneEntrant:
    'A single-elimination draw needs at least 2 entrants — a bracket of one has ' +
    'nobody to play.',
  /** The title over a refused **start** — named after the edge the director clicked,
   * never after the wire call. */
  cannotStart: "Couldn't start the tournament",
  /** The two arms of the go-live refusal, which are two different jobs: an event that was
   * never drawn needs a first cut; a *stale* one has a draw the director may well have
   * reviewed and merely needs to re-cut. */
  noDrawYet: 'no draw yet',
  staleDraw: 'has a draw that no longer matches its entrants',
  /** The freeze reasons, one per frozen control. */
  poolsFrozen: 'a pool can’t be added or removed while the draw stands',
  drawTypeFrozen: 'its draw type is frozen',
  wayOut: 'Delete the draw',
} as const

/**
 * The draw the stub's planner deals for `EVENT.POOLS` — five entrants, two pools — and
 * the reason the spec asserts *these* names in *these* pools rather than "some fixtures
 * appeared".
 *
 * The snake deals row by row across the pools, reversing every other row, so Pool A gets
 * players 1, 4 and 5 while Pool B gets 2 and 3. A **block** deal (the obvious wrong one)
 * would put 1, 2, 3 in Pool A — so this assertion is what tells a real draw from a
 * plausible-looking one.
 *
 * Pool A is ODD (three players), which is the whole reason the field is five: each of its
 * rounds holds **one** fixture, not two, because the player drawn against the phantom
 * seat sits that round out. That absence is the *entire* representation of a bye
 * (ADR-0786), and a scaffold that invented a "bye" row would have to be caught here or
 * nowhere.
 */
const POOL_A = {
  name: 'Pool A',
  entrants: ['player.1', 'player.4', 'player.5'],
  rounds: [
    { round: 1, fixtures: ['player.4 vs player.5'] },
    { round: 2, fixtures: ['player.1 vs player.5'] },
    { round: 3, fixtures: ['player.1 vs player.4'] },
  ],
} as const

const POOL_B = {
  name: 'Pool B',
  entrants: ['player.2', 'player.3'],
  rounds: [{ round: 1, fixtures: ['player.2 vs player.3'] }],
} as const

/** Every fixture the two pools hold together: C(3,2) + C(2,2) = 3 + 1. */
const FIXTURE_COUNT = 4

test.describe('Tournaments · cutting the draw', () => {
  test('the owner generates a draw, sees the pools, re-cuts it, and throws it away', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      drawable: true,
    })
    const event = EVENT.POOLS

    // --- undrawn: a designed data state, not a gap ----------------------------
    await expect(pom.drawEmpty(event)).toContainText(SAY.noDraw)
    await expect(pom.recutDrawButton(event)).toHaveCount(0)
    await expect(pom.deleteDrawButton(event)).toHaveCount(0)
    expect(store.fixturesOf(event)).toEqual([])

    // --- cut it --------------------------------------------------------------
    await pom.generateDrawButton(event).click()

    // The scaffold: pools, their membership, and their fixtures round by round — with
    // NAMES on them. A fixture carries entry ids; the usernames are joined on at render,
    // and a line that read `entry-crowd-4 vs entry-crowd-5` would be a draw no director
    // could use.
    for (const pool of [POOL_A, POOL_B]) {
      await expect(pom.poolEntrants(event, pool.name)).toHaveText([
        ...pool.entrants,
      ])
      for (const { round, fixtures } of pool.rounds) {
        await expect(pom.roundFixtures(event, pool.name, round)).toHaveText([
          ...fixtures,
        ])
      }
    }
    // The empty state is gone, and the verbs have changed to the ones a standing draw has.
    await expect(pom.drawEmpty(event)).toHaveCount(0)
    await expect(pom.generateDrawButton(event)).toHaveCount(0)
    await expect(pom.recutDrawButton(event)).toBeVisible()

    // A bye is the ABSENCE of a fixture (ADR-0786): Pool A's rounds hold one fixture
    // each, not two, and nothing anywhere says the word. A scaffold that emitted a row
    // for the phantom seat would pass every assertion above and fail this one.
    await expect(pom.fixtureLines(event)).toHaveCount(FIXTURE_COUNT)
    await expect(pom.drawPanel(event)).not.toContainText(/bye/i)
    // …and no side is TBD or Withdrawn: a round-robin cut over a live field produces
    // neither, so either word here would mean the join went wrong.
    await expect(pom.drawPanel(event)).not.toContainText('TBD')
    await expect(pom.drawPanel(event)).not.toContainText('Withdrawn')

    // The SERVER cut it — the page is not drawing a picture of its own optimism.
    expect(store.fixturesOf(event)).toHaveLength(FIXTURE_COUNT)

    // --- somebody enters, and the draw is now stale --------------------------
    // Registration stays open right up to go-live, so this is the ordinary way a draw
    // goes out of date: the field the fixtures were dealt from is no longer the field
    // that would play. My name is on the roster and nowhere in the draw.
    await pom.enterButton(event).click()
    await expect(pom.withdrawButton(event)).toBeVisible()
    await expect(pom.drawPanel(event)).not.toContainText(ME.username)

    // --- re-cut: the whole plan is re-made from the field as it now stands ----
    await pom.recutDrawButton(event).click()

    // The re-cut is a real re-deal, not a no-op that left the old fixtures standing: the
    // sixth entrant lands in Pool B (the snake's next seat), and Pool B — a pool of two,
    // with a single round — now has three players and three rounds of its own.
    await expect(pom.poolEntrants(event, POOL_B.name)).toHaveText([
      'player.2',
      'player.3',
      ME.username,
    ])
    await expect(pom.roundFixtures(event, POOL_B.name, 3)).toHaveCount(1)
    expect(store.fixturesOf(event)).toHaveLength(6) // C(3,2) + C(3,2)

    // --- throw it away -------------------------------------------------------
    await pom.deleteDrawButton(event).click()

    // Back to the designed empty state — and the event, its entrants and its pools are
    // all still there. Un-cutting removes the draw, not the event.
    await expect(pom.drawEmpty(event)).toContainText(SAY.noDraw)
    await expect(pom.generateDrawButton(event)).toBeVisible()
    await expect(pom.entrantsList(event)).toContainText(ME.username)
    expect(store.fixturesOf(event)).toEqual([])

    // Every request landed on a route this stub has (an unmocked one would 404 and read
    // as an app bug), and the happy path raised nothing: no toast, and no inline notice.
    expect(store.unhandled).toEqual([])
    await expect(pom.drawNotice(event)).toHaveCount(0)
    await expect(pom.toasts).toHaveCount(0)
  })

  test('a round-robin with NO POOLS is REFUSED (422), in the panel, in the server’s words', async ({
    page,
  }) => {
    // The default seed's U1500 Singles is a round-robin with NO POOLS, so there is
    // nowhere to deal the field: the refusal lands before the entrants are even looked
    // at, and the sentence is the *answer* — it names what to change.
    //
    // This spec used to drive Open Singles and was titled for a draw type nothing could
    // plan. That refusal no longer exists: `DrawType` holds only the types the server has
    // a strategy for (ADR 20260726), so no valid event can be in that state and no server
    // will ever send that sentence. The claim the spec protects — the panel echoes the
    // server's refusal inline, in the server's own words, with no toast — is unchanged;
    // only its subject moved, to a refusal that is about an event's *configuration* and
    // is therefore permanent.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)
    const event = EVENT.EMPTY

    await pom.generateDrawButton(event).click()

    await expect(pom.drawNotice(event)).toBeVisible()
    await expect(pom.drawNotice(event)).toContainText(SAY.cannotDraw)
    await expect(pom.drawNotice(event)).toContainText(SAY.noPools)
    // Told once, not twice: the panel's mutations carry no global toast, because this
    // notice is their error surface (`web-client/CLAUDE.md`, ## Forms).
    await expect(pom.toasts).toHaveCount(0)

    // Nothing was drawn — here or on the server — and the panel is still offering the
    // button, because the refusal is about the event's configuration and not about the
    // click.
    await expect(pom.drawEmpty(event)).toContainText(SAY.noDraw)
    await expect(pom.generateDrawButton(event)).toBeVisible()
    expect(store.fixturesOf(event)).toEqual([])
    // …and it was a 422 from the draw route, not an accident of an unmocked call falling
    // through to a 404. Without this line the test would pass just as happily against no
    // draw endpoint at all.
    expect(store.unhandled).toEqual([])
  })

  test('a SINGLE-ELIM event cuts into a bracket, with its byes left unsaid', async ({
    page,
  }) => {
    // The other draw type the server can run (#785), cut in a browser — which nothing in
    // this suite had ever done. Every seeded event here is round-robin, so the stub's
    // bracket arm, and the columnar `Bracket` renderer the panel swaps in for it, were
    // reachable by no permanent spec: the arm could have been reverted to a refusal and
    // the whole suite would have stayed green.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      bracket: true,
    })
    const event = EVENT.BRACKET

    await expect(pom.drawEmpty(event)).toContainText(SAY.noDraw)
    expect(store.fixturesOf(event)).toEqual([])

    await pom.generateDrawButton(event).click()

    // A field of FIVE in a bracket of eight. Three of the slots are phantom, so seeds 1,
    // 2 and 3 bye — and the whole bracket is these four cards:
    //
    //   Quarterfinals   Semifinals            Final
    //   4 vs 5          1 vs (winner of QF)   TBD vs TBD
    //                   3 vs 2
    //
    // The round NAMES are read back off the final (ADR-0785), which is why round 1 is
    // "Quarterfinals" here and would be a lone "Final" in a two-player event.
    await expect(pom.bracket(event)).toBeVisible()
    await expect(pom.bracketRound(event, 'Quarterfinals')).toHaveText([
      'player.4 vs player.5',
    ])
    await expect(pom.bracketRound(event, 'Semifinals')).toHaveText([
      'player.1 vs TBD',
      'player.3 vs player.2',
    ])
    await expect(pom.bracketRound(event, 'Final')).toHaveText(['TBD vs TBD'])

    // THE bracket assertion (ADR-0786): **a bye is the absence of a fixture.** Round 1
    // holds ONE card, not four with three empty halves, and the byed seeds appear by
    // name one column along instead. A planner that emitted a row per phantom seat, or a
    // renderer that drew the word, would pass every line above and fail these two.
    await expect(pom.fixtureLines(event)).toHaveCount(4)
    await expect(pom.drawPanel(event)).not.toContainText(/bye/i)
    // `TBD` is on the card, and legitimately: a semifinal whose feeder has not been
    // played is a real pairing with one half still being decided. It is NOT a bye, and
    // the count above is what keeps the two apart.

    // A bracket is UN-POOLED — the event has no pools and would ignore them if it had —
    // so the pooled renderer must not appear at all. The two are different components,
    // and "the bracket rendered" and "no pool card rendered" are two claims.
    await expect(pom.poolDraw(event, 'Pool A')).toHaveCount(0)

    // The SERVER cut it, and every fixture it dealt belongs to no pool.
    const fixtures = store.fixturesOf(event)
    expect(fixtures).toHaveLength(4)
    expect(fixtures.every((f) => f.pool_id === null)).toBe(true)

    await expect(pom.drawNotice(event)).toHaveCount(0)
    await expect(pom.toasts).toHaveCount(0)
    expect(store.unhandled).toEqual([])
  })

  test('a bracket with a LONE entrant is REFUSED (422), in the panel, in the server’s words', async ({
    page,
  }) => {
    // The bracket twin of the pool-less refusal above, and the other half of the stub's
    // single-elim arm: a field of one has nobody to play. Kept because a refusal nothing
    // exercises is a refusal that can be quietly deleted — and because the two 422s
    // together are the whole of what a cut can now refuse for, the draw-TYPE arm having
    // left the enum (ADR 20260726).
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      bracket: true,
    })
    const event = EVENT.LONE

    await pom.generateDrawButton(event).click()

    await expect(pom.drawNotice(event)).toBeVisible()
    await expect(pom.drawNotice(event)).toContainText(SAY.cannotDraw)
    await expect(pom.drawNotice(event)).toContainText(SAY.loneEntrant)
    await expect(pom.toasts).toHaveCount(0)

    // Nothing drawn, here or on the server, and the button is still offered: the refusal
    // is about the event's field, which the director can go and change.
    await expect(pom.bracket(event)).toHaveCount(0)
    await expect(pom.drawEmpty(event)).toContainText(SAY.noDraw)
    await expect(pom.generateDrawButton(event)).toBeVisible()
    expect(store.fixturesOf(event)).toEqual([])
    // …and the event beside it is untouched: a refused cut refuses one event, not the
    // tab. (It is the same tournament, and the bracket event is still uncut.)
    expect(store.fixturesOf(EVENT.BRACKET)).toEqual([])
    expect(store.unhandled).toEqual([])
  })

  test('a viewer sees the draw and is offered none of its verbs', async ({ page }) => {
    // Hiding a control is a UX decision, never a security boundary — the API 403s the
    // draw routes independently. But a non-owner who is *offered* Generate is being
    // invited to earn a 403, which ADR-0015 calls an unexplained dead end.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...READY_TO_START,
      canEdit: false,
    })
    const event = EVENT.POOLS

    // The draw itself is public — a player wants to know who they are drawn against.
    await expect(pom.poolEntrants(event, POOL_A.name)).toHaveText([
      ...POOL_A.entrants,
    ])
    await expect(pom.roundFixtures(event, POOL_A.name, 1)).toHaveText([
      ...POOL_A.rounds[0].fixtures,
    ])

    await expect(pom.generateDrawButton(event)).toHaveCount(0)
    await expect(pom.recutDrawButton(event)).toHaveCount(0)
    await expect(pom.deleteDrawButton(event)).toHaveCount(0)
  })
})

test.describe('Tournaments · going live needs a current draw', () => {
  test('a STALE draw refuses the start, names the event, and leaves it Published', async ({
    page,
  }) => {
    // The refusal this whole slice is about, end to end and in a browser: cut the draw,
    // a player enters, start the tournament. Registration stays open right up to go-live
    // (ADR-0017), so the draw a director cut on Tuesday can be stale by Wednesday — and
    // starting on it would schedule a field that is not the field that turned up.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      ...READY_TO_START,
      status: 'published',
    })
    await pom.expectLifecycle('Published', 'Start tournament')

    // A player enters, after the cut. (Me — but it is the *entry* that stales the draw,
    // not who made it: the draw seats a set of entries, and this is one more.)
    await pom.enterButton(EVENT.JOURNEY).click()
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()

    await pom.lifecycleButton('Start tournament').click()

    // THE assertion, half one: the refusal is inline, beside the button that was clicked,
    // and it is a WORK LIST — it names the event whose draw went stale. A director with
    // ten events, told merely "something isn't ready", is left clicking through all ten;
    // a toast would take the list away after four seconds, which is why this is an Alert.
    await expect(pom.lifecycleNotice).toBeVisible()
    await expect(pom.lifecycleNotice).toContainText(SAY.cannotStart)
    await expect(pom.lifecycleNotice).toContainText(`“${EVENT.JOURNEY}”`)
    await expect(pom.lifecycleNotice).toContainText(SAY.staleDraw)
    // A stale draw is not an uncut one — the director is told their draw needs RE-cutting,
    // not that they never cut it — and the event whose draw is still current is not blamed.
    await expect(pom.lifecycleNotice).not.toContainText(SAY.noDrawYet)
    await expect(pom.lifecycleNotice).not.toContainText(`“${EVENT.POOLS}”`)
    await expect(pom.toasts).toHaveCount(0)

    // THE assertion, half two: the tournament did NOT move. The pill still reads
    // Published — the refusal is judged before the write, so a refused start leaves the
    // tournament exactly where it was — and the button that was refused is still there,
    // because the way out is to re-cut and click it again.
    await pom.expectLifecycle('Published', 'Start tournament')
    expect(store.status).toBe('published')
    expect(store.unhandled).toEqual([])

    // --- and the way out really is the way out --------------------------------
    // The notice says: cut the draw again, then start. So do exactly that. Without this,
    // the spec would prove only that the tournament is stuck.
    await pom.recutDrawButton(EVENT.JOURNEY).click()
    await expect(pom.drawPanel(EVENT.JOURNEY)).toContainText(ME.username)

    await pom.lifecycleButton('Start tournament').click()

    await pom.expectLifecycle('Live', 'End tournament')
    expect(store.status).toBe('live')
    // The refusal from the click before it is GONE — cleared when the next attempt
    // started, because a notice about the click before last is worse than none.
    await expect(pom.lifecycleNotice).toHaveCount(0)
  })

  test('an UNDRAWN event refuses the start, and names every event at fault', async ({
    page,
  }) => {
    // The other arm of the precondition, and the one the old stub was silently waving
    // through: this tournament's events have no draw at all. (It can never be started, in
    // fact — one of its events has no entrants, and no draw can cover an empty field —
    // which is precisely why the go-live specs seed a different tournament.)
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'published',
    })

    await pom.lifecycleButton('Start tournament').click()

    await expect(pom.lifecycleNotice).toBeVisible()
    await expect(pom.lifecycleNotice).toContainText(SAY.cannotStart)
    await expect(pom.lifecycleNotice).toContainText(SAY.noDrawYet)
    // Named, all of them — the whole work list, not the first one it tripped over.
    await expect(pom.lifecycleNotice).toContainText(`“${EVENT.JOURNEY}”`)
    await expect(pom.lifecycleNotice).toContainText(`“${EVENT.EMPTY}”`)
    await expect(pom.lifecycleNotice).toContainText(`“${EVENT.DOUBLES}”`)

    await pom.expectLifecycle('Published', 'Start tournament')
    expect(store.status).toBe('published')
    expect(store.unhandled).toEqual([])
  })
})

test.describe('Tournaments · the event editor, with a draw standing', () => {
  test('freezes the draw type and the pool SET — with the reason attached to each dead control', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      drawable: true,
      drawn: [EVENT.POOLS],
    })

    await pom.openEditor(EVENT.POOLS)
    await expect(pom.eventEditor).toBeVisible()

    // --- Basics: the draw type is spoken for ---------------------------------
    // Still shown, still readable — it is a fact about the event the director came here
    // to check. It just cannot be changed: the fixtures were dealt AS a round robin.
    await expect(pom.drawTypeSelect).toBeDisabled()
    await expect(pom.drawTypeSelect).toContainText('Round robin')

    // …and the reason is *attached* to it, not merely printed underneath it. A disabled
    // trigger is not focusable and carries no tooltip, so `aria-describedby` is the only
    // channel it has — and it had none at all until now, while the pools section one tab
    // over wired the identical freeze correctly.
    const drawTypeReason = await pom.describedBy(pom.drawTypeSelect)
    await expect(drawTypeReason).toContainText(SAY.drawTypeFrozen)
    await expect(drawTypeReason).toContainText(SAY.wayOut)

    // --- Table pools: the SET is frozen, and says how to unfreeze it ----------
    await pom.editorTab('Table pools').click()

    await expect(pom.poolsFrozenNotice).toBeVisible()
    await expect(pom.poolsFrozenNotice).toContainText(SAY.poolsFrozen)
    await expect(pom.poolsFrozenNotice).toContainText(SAY.wayOut)

    // Disabled — not hidden. This button is one deleted draw away from working, and
    // hiding it would hide the way out along with it (contrast the viewer's controls,
    // which are absent because nothing they could do would bring them back).
    await expect(pom.addPoolButton).toBeDisabled()
    await expect(await pom.describedBy(pom.addPoolButton)).toContainText(
      SAY.poolsFrozen,
    )

    // Every Remove, not just the first: "the removes are dead" is the claim.
    await expect(pom.removePoolButtons).toHaveCount(2)
    for (const remove of await pom.removePoolButtons.all()) {
      await expect(remove).toBeDisabled()
      await expect(await pom.describedBy(remove)).toContainText(SAY.poolsFrozen)
    }
  })

  test('leaves a pool’s TABLES editable — and the draw survives the save', async ({
    page,
  }) => {
    // The case the freeze exists to permit, and the one a wholesale grey-out would break.
    // A table breaks on the morning of the tournament and is pulled; the director has to
    // be able to record that. Only the pool *set* is frozen — a pool's tables, its window
    // and its name are still the director's, because otherwise they would have to destroy
    // a perfectly good draw to move a table.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      drawable: true,
      drawn: [EVENT.POOLS],
    })
    const drawn = store.fixturesOf(EVENT.POOLS).length
    expect(drawn).toBe(FIXTURE_COUNT)

    await pom.openEditor(EVENT.POOLS)
    await pom.editorTab('Table pools').click()

    // Pool A holds T1 and T2. Add T3 to it — a live control on a card whose Remove button
    // is dead.
    const chip = pom.poolTableChip(0, 'T3')
    await expect(chip).toBeEnabled()
    await expect(chip).toHaveAttribute('aria-pressed', 'false')
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')

    await pom.saveEventButton.click()
    await expect(pom.eventEditor).toHaveCount(0)

    // The server took it: the pool really did gain the table…
    expect(store.poolsOf(EVENT.POOLS)[0].table_ids).toEqual(['t1', 't2', 't3'])
    // …and the draw is still standing. A PATCH is not a re-cut, and a director who moved
    // a table must not discover their draw was thrown away by the save.
    expect(store.fixturesOf(EVENT.POOLS)).toHaveLength(drawn)
    await expect(pom.poolEntrants(EVENT.POOLS, POOL_A.name)).toHaveText([
      ...POOL_A.entrants,
    ])
    await expect(pom.toasts).toHaveCount(0)
    expect(store.unhandled).toEqual([])
  })
})

/**
 * The **draw types a director can pick** (ADR 20260726), through the real browser.
 *
 * A row in the API's `draw_types` table means "this draw type has an implementation", and
 * the tournament-detail payload serves those rows (`draw_type_catalogue`). The client
 * keeps no list of its own: the picker renders what it was sent. So "no un-backed slug is
 * selectable" is settled **at the point of choice** — the director never picks a format
 * the server cannot run, enters a whole field, and meets a 422 four steps later.
 *
 * The component tests (`basics-section.test.tsx`) already drive the picker off a
 * hand-written catalogue. What only a browser adds is the CHAIN: the payload really
 * carries the rows, they really survive the Zod parse at the fetch boundary
 * (`parseDrawTypeCatalogue`), they are really threaded down through the page into the
 * editor's Basics tab, and a real radix listbox really renders them. Every link of that
 * is code the vitest suite stubs past.
 */
test.describe('Tournaments · the draw types a director is offered', () => {
  /** The two labels the API SEEDS, verbatim — a copy of the migration's `DRAW_TYPE_SEED`,
   * as the stub's catalogue is. Spelled out here rather than imported for the same reason
   * `SAY` is: an assertion that read the labels out of the fixture it is asserting on
   * could only ever prove the fixture equals itself. */
  const SEEDED_LABELS = ['Round robin', 'Single elimination']

  test('offers exactly the two seeded draw types, in the server’s words', async ({
    page,
  }) => {
    // The default seed, whose events are all uncut — so the picker is live rather than
    // frozen (a cut draw disables it; that case is two describes up).
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditor(EVENT.JOURNEY)
    await expect(pom.eventEditor).toBeVisible()

    // EXACTLY these, and in this order. `toEqual` is the assertion the claim needs:
    // "double elimination", "Swiss" and "round robin then knockout" were all on this
    // menu, and each one let a director author an event nothing could ever cut. They
    // left the API's enum, so they are not seeded, so they are not here — and a
    // `toContain` pair would not have noticed if they came back.
    expect(await pom.drawTypeOptions()).toEqual(SEEDED_LABELS)

    expect(store.unhandled).toEqual([])
  })

  test('follows the SERVED catalogue — its labels and its display order', async ({
    page,
  }) => {
    // The falsification for the spec above, which on its own would pass just as happily
    // against the hardcoded `DRAW_TYPE_OPTIONS` this ADR deleted. Serve a catalogue that
    // agrees with the seed about nothing a client could guess: different words, and an
    // ARRAY order that contradicts `display_order` (so a picker rendering the array as it
    // came would put these the wrong way round, and one sorting alphabetically would
    // too).
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      drawTypeCatalogue: [
        {
          key: 'single-elim',
          name: 'Knockout bracket',
          description: 'Lose once and you are out.',
          display_order: 2,
        },
        {
          key: 'round-robin',
          name: 'Everyone plays everyone',
          description: 'Every entrant plays every other in their pool.',
          display_order: 1,
        },
      ],
    })

    await pom.openEditor(EVENT.JOURNEY)
    await expect(pom.eventEditor).toBeVisible()

    expect(await pom.drawTypeOptions()).toEqual([
      'Everyone plays everyone',
      'Knockout bracket',
    ])
    // And the seeded words are gone with the seeded rows — the picker holds no copy of
    // its own to fall back on.
    for (const label of SEEDED_LABELS) {
      await expect(page.getByRole('option', { name: label })).toHaveCount(0)
    }
  })
})

/**
 * ⚠️ **A pre-existing violation, and not this change's to fix.** The shared
 * `Button variant="destructive"` (`.bg-destructive` + white text) fails AA colour
 * contrast, and the event editor's "Delete event" is one of them — so any scan with the
 * editor open trips on it. It is a design-system defect on every destructive button in
 * the app, and its fix is a shared token. Named here, not hidden, exactly as
 * `event-editor.spec.ts` names it. **Follow-up ticket.**
 */
const KNOWN_DESTRUCTIVE_BUTTON_CONTRAST = ['.bg-destructive']

test.describe('Tournaments · the draw · accessibility', () => {
  test('is axe-clean with the pools scaffold on screen', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, READY_TO_START)

    // Prove the state is really rendered before scanning it: an axe pass over a page that
    // has not reached the state is a green that means nothing. (Until this slice, CI's
    // axe only ever saw the *undrawn* panel — the drawn one was unreachable from any
    // spec, because every stubbed event had `fixtures: []`.)
    await expect(pom.poolEntrants(EVENT.POOLS, POOL_A.name)).toHaveText([
      ...POOL_A.entrants,
    ])

    await expectAxeClean(page, 'tournament detail — the drawn pools scaffold')
  })

  test('is axe-clean with the draw refusal on screen', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    // Same subject as the refusal spec above, for the same reason: `EVENT.EMPTY` is the
    // pool-less round-robin, i.e. the one event in the default seed whose Generate click
    // puts a real server refusal on screen for axe to scan.
    await pom.generateDrawButton(EVENT.EMPTY).click()
    await expect(pom.drawNotice(EVENT.EMPTY)).toBeVisible()

    await expectAxeClean(page, 'tournament detail — the refused draw notice')
  })

  test('is axe-clean with the go-live refusal on screen', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...READY_TO_START,
      status: 'published',
    })
    await pom.enterButton(EVENT.JOURNEY).click()
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()

    await pom.lifecycleButton('Start tournament').click()
    await expect(pom.lifecycleNotice).toContainText(SAY.staleDraw)

    await expectAxeClean(page, 'tournament detail — the refused go-live notice')
  })

  test('is axe-clean with the FROZEN editor open', async ({ page }) => {
    // The state most likely to be missed by a scan, and the one where the accessibility
    // tree is doing the most work: two disabled controls whose only remaining channel is
    // the description they point at.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      drawable: true,
      drawn: [EVENT.POOLS],
    })

    await pom.openEditor(EVENT.POOLS)
    await expect(pom.drawTypeSelect).toBeDisabled()

    await expectAxeClean(page, 'tournament detail — the frozen editor, Basics', {
      exclude: KNOWN_DESTRUCTIVE_BUTTON_CONTRAST,
    })

    await pom.editorTab('Table pools').click()
    await expect(pom.poolsFrozenNotice).toBeVisible()
    await expect(pom.addPoolButton).toBeDisabled()

    await expectAxeClean(page, 'tournament detail — the frozen editor, Table pools', {
      exclude: KNOWN_DESTRUCTIVE_BUTTON_CONTRAST,
    })
  })
})
