/**
 * Tournament self-registration, through the real browser (ADR-0016).
 *
 * The tournaments area had no e2e coverage at all before this file. What it is
 * here to prove, and what only a browser CAN prove:
 *
 *   1. **Re-entry after withdrawal.** enter → withdraw → **enter again**. This is
 *      the single most important assertion in the slice: it is the entire reason
 *      the database's unique index is *partial* rather than plain. A plain index
 *      would lock a player out of any event they ever withdrew from, forever, and
 *      every other test in the suite would still pass.
 *
 *   2. **Click isolation.** The Enter control sits inside a card whose whole body
 *      is covered by a stretched "open the editor" overlay button. It clears that
 *      overlay purely by z-index stacking. jsdom has no layout and no paint, so a
 *      `userEvent.click` in vitest lands on the control *regardless* of stacking
 *      — a unit test cannot fail this, no matter how wrong the CSS gets. If the
 *      shared `Card` ever gains a stacking context and the overlay starts
 *      swallowing Enter, this spec is the only thing in the repo that catches it.
 *
 *   3. **axe-clean** in each state the roster and the control can be in.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT, ME } from '../page-objects/tournaments/tournaments-store'
import { PERM } from '../../src/lib/permissions'
import { expectAxeClean } from '../support/axe'

/** Roster copy, hard-coded test-side on purpose: importing the strings from the
 * component would make the assertion a tautology (it would pass whatever the
 * copy became). Straight ASCII apostrophe — `&apos;` renders as one. */
const COPY = {
  emptyLead: 'No one has entered yet.',
  emptyBody: 'Players who enter this event will be listed here.',
  closedLead: "Doubles events can't be entered yet.",
  closedBody: 'Entry is open for singles only, so no one can sign up for this event.',
}

test.describe('Tournaments · entering an event', () => {
  test('a permitted player enters, appears in the roster, withdraws — and enters AGAIN', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    // --- before: two other players are in, and I am not ---------------------
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText('player.1')
    await expect(pom.entrantsList(EVENT.JOURNEY)).not.toContainText(ME.username)
    await pom.expectEntryCount(EVENT.JOURNEY, 2, 64)
    await expect(pom.heroEntries).toContainText('2')
    await expect(pom.enterButton(EVENT.JOURNEY)).toBeVisible()

    // --- enter ---------------------------------------------------------------
    await pom.enterButton(EVENT.JOURNEY).click()

    // The control flips to Withdraw, my name joins the roster, and the count —
    // derived server-side from that same roster — goes up. All three come from
    // the refetch the mutation invalidates, not from optimistic local state.
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText(ME.username)
    await pom.expectEntryCount(EVENT.JOURNEY, 3, 64)
    await expect(pom.heroEntries).toContainText('3')

    // --- withdraw ------------------------------------------------------------
    await pom.withdrawButton(EVENT.JOURNEY).click()

    await expect(pom.enterButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.JOURNEY)).not.toContainText(ME.username)
    await pom.expectEntryCount(EVENT.JOURNEY, 2, 64)
    await expect(pom.heroEntries).toContainText('2')

    // --- enter AGAIN ---------------------------------------------------------
    // THE assertion. Against a plain `UNIQUE (event_id, user_id)` this is a 409:
    // my own withdrawn row would collide with my new one and I would be locked
    // out of an event I had merely changed my mind about.
    await pom.enterButton(EVENT.JOURNEY).click()

    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText(ME.username)
    await pom.expectEntryCount(EVENT.JOURNEY, 3, 64)

    // Not a single toast: no step of this journey is an error, and a 409
    // surfacing as "you're already entered" would toast rather than crash — so
    // "no toast" is what distinguishes a real re-entry from a swallowed one.
    await expect(pom.toasts).toHaveCount(0)

    // And the server saw exactly the journey the UI claims: two entries, one
    // withdrawal — never a second concurrent entry.
    expect(store.countOf('POST')).toBe(2)
    expect(store.countOf('DELETE')).toBe(1)
    expect(store.entrantsOf(EVENT.JOURNEY).map((e) => e.username)).toEqual([
      'player.1',
      'player.2',
      ME.username,
    ])
    // Nothing the page asked for went unmocked (an unmocked call would 404 and
    // read as a feature bug).
    expect(store.unhandled).toEqual([])
  })

  test('clicking Enter does not open the event editor — the stretched card overlay does not swallow it', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page)
    await expect(pom.eventEditor).toHaveCount(0)

    await pom.enterButton(EVENT.JOURNEY).click()

    // The click must have LANDED (else "no dialog" proves nothing — a click that
    // missed the button entirely would also open no dialog) …
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()
    expect(store.countOf('POST')).toBe(1)
    // … and it must not ALSO have hit the overlay underneath it.
    await expect(pom.eventEditor).toHaveCount(0)

    // Withdraw sits in the same slot, so it is exposed to the same overlay.
    await pom.withdrawButton(EVENT.JOURNEY).click()
    await expect(pom.enterButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.eventEditor).toHaveCount(0)

    // The positive control for all of the above: the overlay IS there and DOES
    // open the editor. Without this, a `toHaveCount(0)` on a dialog that can
    // never open would be a spec that passes by tautology.
    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventEditor).toContainText(EVENT.JOURNEY)
  })

  test('the Enter control is disabled while the entry is in flight (no double-submit)', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    const release = store.holdWrites()
    await pom.enterButton(EVENT.JOURNEY).click()

    // Held mid-flight: a second click cannot produce a second entry, because
    // there is nothing left to click.
    await expect(pom.enterButton(EVENT.JOURNEY)).toBeDisabled()

    release()
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()
    expect(store.countOf('POST')).toBe(1)
    expect(store.entrantsOf(EVENT.JOURNEY)).toHaveLength(3)
  })

  test('an event nobody has entered shows designed empty copy — and is still enterable', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    const card = pom.eventCard(EVENT.EMPTY)

    // Empty is a data state, not a gap and not an error.
    await expect(card).toContainText(COPY.emptyLead)
    await expect(card).toContainText(COPY.emptyBody)
    await expect(pom.entrantsList(EVENT.EMPTY)).toHaveCount(0)
    await pom.expectEntryCount(EVENT.EMPTY, 0, 48)

    // "Nobody has entered" is an invitation, not a closed door: the control is
    // offered, and taking it turns the empty copy into a real roster.
    await pom.enterButton(EVENT.EMPTY).click()

    await expect(pom.entrantsList(EVENT.EMPTY)).toContainText(ME.username)
    await expect(card).not.toContainText(COPY.emptyLead)
    await pom.expectEntryCount(EVENT.EMPTY, 1, 48)
  })

  test('entering a BUSY event still shows me my own name — the roster cannot truncate me away', async ({
    page,
  }) => {
    // #781's acceptance criterion, in the only witness that counts: the server
    // lists entrants oldest-entry-first, so entering an event that already holds
    // more people than the card lists appends me PAST the cut-off. The first-8
    // slice told me I was in (count up, Withdraw offered) and showed me a roster
    // I was not in.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      crowded: true,
    })

    // --- before: twelve strangers, the oldest eight shown, four hidden -------
    await expect(pom.entrantsList(EVENT.CROWDED)).toContainText('player.1')
    await expect(pom.entrantsList(EVENT.CROWDED)).not.toContainText(ME.username)
    await expect(pom.truncationTail(EVENT.CROWDED)).toHaveText('+4 more')
    await pom.expectEntryCount(EVENT.CROWDED, 12, 64)

    // --- enter ---------------------------------------------------------------
    await pom.enterButton(EVENT.CROWDED).click()

    await expect(pom.withdrawButton(EVENT.CROWDED)).toBeVisible()
    await pom.expectEntryCount(EVENT.CROWDED, 13, 64)

    // THE assertion: I am thirteenth of thirteen, and on screen anyway — pinned
    // to the front of the roster, and marked, because a chip that jumps the queue
    // has to say why.
    await expect(pom.entrantsList(EVENT.CROWDED)).toContainText(ME.username)
    await expect(pom.entrantItems(EVENT.CROWDED).first()).toContainText(
      ME.username,
    )
    await expect(pom.entrantItems(EVENT.CROWDED).first()).toContainText('(you)')

    // …and the tail stays honest: 13 entrants, 8 chips (me + the 7 oldest) → 5
    // hidden. Pinning me REORDERS the roster; it does not drop `player.8` out of
    // the count, nor count me among the hidden.
    await expect(pom.truncationTail(EVENT.CROWDED)).toHaveText('+5 more')
    await expect(pom.entrantsList(EVENT.CROWDED)).toContainText('player.7')

    // The server agrees I really am in it — and that it appended me last, which
    // is precisely what made the bug invisible to the count-only assertions.
    expect(store.entrantsOf(EVENT.CROWDED)).toHaveLength(13)
    expect(store.entrantsOf(EVENT.CROWDED).at(-1)?.username).toBe(ME.username)
    await expect(pom.toasts).toHaveCount(0)

    // --- and back out --------------------------------------------------------
    // Withdrawing takes my chip (and its tag) away again: the pin follows my
    // ENTRY, it is not a sticky decoration.
    await pom.withdrawButton(EVENT.CROWDED).click()

    await expect(pom.enterButton(EVENT.CROWDED)).toBeVisible()
    await expect(pom.entrantsList(EVENT.CROWDED)).not.toContainText(ME.username)
    await expect(pom.entrantItems(EVENT.CROWDED).first()).toContainText('player.1')
    await expect(pom.truncationTail(EVENT.CROWDED)).toHaveText('+4 more')
  })

  test('a doubles event offers no Enter control, and says why instead of lying about it', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    const card = pom.eventCard(EVENT.DOUBLES)

    // Positive first: the card is genuinely on screen, so the absence below is
    // an absence of the control and not of the page.
    await expect(card).toBeVisible()
    await pom.expectEntryCount(EVENT.DOUBLES, 0, 32)

    // Absent, not disabled: one entry row cannot express a pairing, so entering
    // could only ever 400 server-side (ADR-0016).
    await expect(pom.enterButton(EVENT.DOUBLES)).toHaveCount(0)
    await expect(pom.withdrawButton(EVENT.DOUBLES)).toHaveCount(0)

    // …and the roster says so, rather than "No one has entered yet", which would
    // promise a door that does not exist.
    await expect(card).toContainText(COPY.closedLead)
    await expect(card).toContainText(COPY.closedBody)
    await expect(card).not.toContainText(COPY.emptyLead)

    // The editor still opens — the card is not inert, it just cannot be entered.
    await pom.openEditorOverlay(EVENT.DOUBLES).click()
    await expect(pom.eventEditor).toBeVisible()
  })

  test('a player without tournament.enter sees no Enter control anywhere', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      permissions: [PERM.TOURNAMENT_VIEW],
    })

    // The page is fully there — cards, rosters, counts…
    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText('player.1')
    await pom.expectEntryCount(EVENT.JOURNEY, 2, 64)

    // …it just offers nothing to click. Every event, both directions.
    for (const name of [EVENT.JOURNEY, EVENT.EMPTY, EVENT.DOUBLES]) {
      await expect(pom.enterButton(name)).toHaveCount(0)
      await expect(pom.withdrawButton(name)).toHaveCount(0)
    }
  })
})

test.describe('Tournaments · entering an event · accessibility', () => {
  test('is axe-clean before entering — with a listed, an empty and an entry-closed roster on screen', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    // The seed puts all three roster states on the page at once, so this single
    // scan covers every one of them. Assert they are actually rendered first —
    // an axe scan of a page missing two of its three states is a green that
    // means nothing.
    await expect(pom.entrantsList(EVENT.JOURNEY)).toBeVisible() // listed
    await expect(pom.eventCard(EVENT.EMPTY)).toContainText(COPY.emptyLead) // empty
    await expect(pom.eventCard(EVENT.DOUBLES)).toContainText(COPY.closedLead) // entry-closed
    await expect(pom.enterButton(EVENT.JOURNEY)).toBeVisible()

    await expectAxeClean(page, 'events tab before entering')
  })

  test('is axe-clean after entering — roster populated, Withdraw offered', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    await pom.enterButton(EVENT.JOURNEY).click()
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText(ME.username)

    await expectAxeClean(page, 'events tab after entering')
  })

  test('is axe-clean with a TRUNCATED roster — my pinned chip and the "+N more" tail', async ({
    page,
  }) => {
    // The fourth roster state (#781): my own chip, marked and hoisted, next to a
    // tail that is text rather than a control. Both are new markup inside the
    // list — and both sit under the card's stretched overlay.
    const { pom } = await TournamentDetailPage.navigateTo(page, { crowded: true })
    await pom.enterButton(EVENT.CROWDED).click()

    await expect(pom.entrantItems(EVENT.CROWDED).first()).toContainText(
      ME.username,
    )
    await expect(pom.truncationTail(EVENT.CROWDED)).toBeVisible()

    await expectAxeClean(page, 'events tab with a truncated roster')
  })
})
