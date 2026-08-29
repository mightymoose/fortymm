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
import {
  EVENT,
  ME,
  MY_RATING_ROUNDED,
} from '../page-objects/tournaments/tournaments-store'
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
    // …and the card says what is LEFT, not just what is in (#783).
    await expect(pom.capacityNote(EVENT.JOURNEY)).toHaveText('62 places left')
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
    // The place I just took is a place nobody else can: the remainder moves with
    // the roster, because both are read off the same derived count.
    await expect(pom.capacityNote(EVENT.JOURNEY)).toHaveText('61 places left')

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

  test('a STALE tab that clicks Enter reconciles to the truth — it does not freeze on a render the 409 disproved', async ({
    page,
  }) => {
    // The QA repro (#943), in the browser: the same player has this tournament
    // open in two tabs. The other tab enters. THIS one still renders the world as
    // it was — `0 / 48`, an Enter button, "No one has entered yet" — and clicking
    // Enter is therefore a duplicate the server refuses with a 409.
    //
    // Only a browser can prove the whole of what has to happen next, because it is
    // the *page* that must catch up: the count, the roster, the empty copy and the
    // control are four independent renders off one refetch.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)
    const card = pom.eventCard(EVENT.EMPTY)

    await pom.expectEntryCount(EVENT.EMPTY, 0, 48)
    await expect(pom.enterButton(EVENT.EMPTY)).toBeVisible()
    await expect(card).toContainText(COPY.emptyLead)
    await expect(pom.heroEntries).toContainText('2') // the journey event's two

    // --- the other tab enters, and this page is none the wiser ---------------
    store.enterElsewhere(EVENT.EMPTY)

    // Still stale, and that is the point: the page has NOT refetched behind our
    // backs (if it had, the assertions below would prove nothing at all).
    await pom.expectEntryCount(EVENT.EMPTY, 0, 48)
    await expect(pom.enterButton(EVENT.EMPTY)).toBeVisible()

    // --- click Enter on the stale card ---------------------------------------
    await pom.enterButton(EVENT.EMPTY).click()

    // THE assertion. The POST 409s — and the card comes back TRUE rather than
    // sitting frozen on its pre-click render: I am in the roster, the count says
    // so, the empty copy is gone, and the control now offers the only action that
    // is actually available to me.
    await expect(pom.withdrawButton(EVENT.EMPTY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.EMPTY)).toContainText(ME.username)
    await pom.expectEntryCount(EVENT.EMPTY, 1, 48)
    await expect(card).not.toContainText(COPY.emptyLead)
    await expect(pom.heroEntries).toContainText('3') // the whole page caught up

    // The 409 is told gently: I *am* entered, and the screen now says so, so a red
    // "Couldn't enter the event" on top of it would contradict the very card it
    // was covering. One informational note, and no error.
    await expect(pom.toasts).toHaveCount(1)
    await expect(pom.toasts).toContainText('You were already entered in this event')
    await expect(pom.toasts).not.toContainText("Couldn't")

    // …and the reconciled view is a WORKING one, not a picture: the entry id it
    // withdraws by came from the refetch, so Withdraw addresses the real entry.
    await pom.withdrawButton(EVENT.EMPTY).click()

    await expect(pom.enterButton(EVENT.EMPTY)).toBeVisible()
    await pom.expectEntryCount(EVENT.EMPTY, 0, 48)
    expect(store.entrantsOf(EVENT.EMPTY)).toEqual([])
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

  test('a zero-permission player still gets the Enter control (#1092)', async ({
    page,
  }) => {
    // Entering needs no permission any more — the default session's empty
    // permission list is exactly what a real default user holds.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      permissions: [],
    })

    // The page is fully there — cards, rosters, counts…
    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText('player.1')
    await pom.expectEntryCount(EVENT.JOURNEY, 2, 64)

    // …and the singles events offer Enter.
    for (const name of [EVENT.JOURNEY, EVENT.EMPTY]) {
      await expect(pom.enterButton(name)).toBeVisible()
      await expect(pom.withdrawButton(name)).toHaveCount(0)
    }
    // Doubles still offers nothing to click.
    await expect(pom.enterButton(EVENT.DOUBLES)).toHaveCount(0)
    await expect(pom.withdrawButton(EVENT.DOUBLES)).toHaveCount(0)
  })
})

/**
 * What the EVENT itself refuses (#783, ADR-0783) — and what it shows instead.
 *
 * Issue #783's own text asked for a *disabled* Enter button. These specs are what
 * says we did not build one: the assertion is not "the button is disabled", it is
 * "**the card offers no button at all**" (ADR-0015 — a disabled control is an
 * unexplained dead end; hide the affordance and explain).
 *
 * Only a browser can prove the last one honestly: `cardButtons()` sweeps every
 * button *inside* the card, so a dead control that was renamed, unlabelled or
 * merely greyed out cannot hide behind an accessible-name query.
 */
test.describe('Tournaments · what the event refuses (#783)', () => {
  test('a FULL event explains itself and offers no button to press — not even a disabled one', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, { gated: true })
    const card = pom.eventCard(EVENT.FULL)

    // Positive first: the card is genuinely rendered, and genuinely full — so the
    // absence below is an absence of the control, not of the page.
    await expect(card).toBeVisible()
    await pom.expectEntryCount(EVENT.FULL, 4, 4)
    // Its capacity line reads FULL — not the "0 places left" that the arithmetic
    // would give, and not a negative one (#783).
    await expect(pom.capacityNote(EVENT.FULL)).toHaveText('Full')
    await expect(card).not.toContainText('places left')
    // …while an event with room counts the places it has left, on the same page.
    await expect(pom.capacityNote(EVENT.JOURNEY)).toHaveText('62 places left')

    await expect(pom.fullNotice(EVENT.FULL)).toContainText('Event full')
    await expect(pom.fullNotice(EVENT.FULL)).toContainText(
      'Every place in this event has been taken.',
    )
    // No Enter. And nothing else button-shaped inside the card either — the
    // stretched "open the editor" overlay is a sibling of the card, not a child.
    await expect(pom.enterButton(EVENT.FULL)).toHaveCount(0)
    await expect(pom.withdrawButton(EVENT.FULL)).toHaveCount(0)
    await expect(pom.cardButtons(EVENT.FULL)).toHaveCount(0)

    // …while an event with room still offers a working Enter, on the same page.
    await expect(pom.enterButton(EVENT.JOURNEY)).toBeEnabled()
  })

  test('a RATING-INELIGIBLE event names the rule that refused me, and the rating it judged', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, { gated: true })

    const notice = pom.ineligibleNotice(EVENT.INELIGIBLE)
    await expect(notice).toContainText('Not eligible')
    // Specific enough to act on: the event's own rule, read back by id, and my
    // rating on the tournament's ladder. Not "you are not eligible", full stop.
    //
    // And the rating is ROUNDED — the store judges me on the raw Glicko float the
    // server really sends (`1662.3108939062977`), so this line is what catches the
    // notice printing thirteen decimal places at a player, as it did in QA. Every
    // other rating surface in the app says `1662`; so does this one.
    await expect(notice).toContainText(
      `Rating is less than 1200. Your rating is ${MY_RATING_ROUNDED}.`,
    )
    await expect(notice).not.toContainText('1662.3')

    await expect(pom.enterButton(EVENT.INELIGIBLE)).toHaveCount(0)
    await expect(pom.cardButtons(EVENT.INELIGIBLE)).toHaveCount(0)

    // …and the capacity line still counts the event's free places (2 of 24 in),
    // because it is read off the numbers, not off `entry_state` — which, for this
    // caller, says `rating_ineligible` and nothing whatever about room. The event
    // has 22 places; this player simply cannot take one of them. Both facts,
    // honestly, side by side (#783).
    await expect(pom.capacityNote(EVENT.INELIGIBLE)).toHaveText('22 places left')
  })

  // ⚠️ THE TRAP. A player already inside a full event must still be able to LEAVE.
  // If capacity outranked membership, every entrant in a popular event would find
  // their Withdraw button replaced by "Event full" — locked in by the very success
  // they signed up for, with no way out and nothing to click.
  test('a player already entered in a FULL event can still WITHDRAW from it', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      gated: true,
      // I hold one of the four places — which is what makes the event full.
      enteredIn: [EVENT.FULL_WITH_ME],
    })

    await pom.expectEntryCount(EVENT.FULL_WITH_ME, 4, 4)
    await expect(pom.entrantsList(EVENT.FULL_WITH_ME)).toContainText(ME.username)
    // The event IS full — the capacity line says so even to the one person it has
    // nothing to explain, because "no places left" is a fact about the event, not
    // about who is reading it.
    await expect(pom.capacityNote(EVENT.FULL_WITH_ME)).toHaveText('Full')
    // The card explains nothing at me — it offers me the door out.
    await expect(pom.fullNotice(EVENT.FULL_WITH_ME)).toHaveCount(0)
    await expect(pom.withdrawButton(EVENT.FULL_WITH_ME)).toBeVisible()

    await pom.withdrawButton(EVENT.FULL_WITH_ME).click()

    // The withdrawal really landed: the server's own roster lost me, the count
    // dropped, and the place I freed is offered back to me — and it is ONE place,
    // singular, not "1 places left".
    await expect(pom.enterButton(EVENT.FULL_WITH_ME)).toBeVisible()
    await pom.expectEntryCount(EVENT.FULL_WITH_ME, 3, 4)
    await expect(pom.capacityNote(EVENT.FULL_WITH_ME)).toHaveText('1 place left')
    expect(store.entrantsOf(EVENT.FULL_WITH_ME).map((e) => e.username)).not.toContain(
      ME.username,
    )
    await expect(pom.toasts).toHaveCount(0)
  })
})

/**
 * The **visible loophole** (ADR-0783 §3).
 *
 * An unrated player passes every rating rule — `rating < 1200` admits someone who
 * holds no rating at all — because the alternative bars a beginner from the
 * beginners' event. The accepted cost: a rating cap is **opt-out**. Never play a
 * rated match, stay unrated, stay eligible for every capped event.
 *
 * The whole mitigation is that the entrants list *says so*. The director is the only
 * person who can act on a ringer (they may withdraw them, #784), and they can only
 * act on what they can see — so these specs assert the mark is on the right chips,
 * in a **word** (not a hue: a colour-only mark is invisible to a director who cannot
 * see it, and to a screen reader entirely), and that a roster of nothing but unrated
 * entrants still renders.
 */
test.describe('Tournaments · the unrated entrant (#783)', () => {
  test('marks the entrant who holds no rating — and leaves the rated one unmarked', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    // Both are in the roster: the mark is an annotation on a roster, not a filter
    // over one.
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText('player.1')
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText('player.2')

    // Exactly one of them is marked, and it is the one who holds no rating.
    await expect(pom.unratedEntrantItems(EVENT.JOURNEY)).toHaveCount(1)
    await expect(pom.unratedEntrantItems(EVENT.JOURNEY)).toContainText('player.2')

    // THE assertion, and the reason this is a browser spec: the mark is a WORD in
    // the accessibility tree. A tinted chip would look right in a screenshot, pass
    // every DOM-count test written against it, and tell a colour-blind director —
    // and every screen-reader user — precisely nothing.
    await expect(pom.unratedTags(EVENT.JOURNEY)).toHaveCount(1)
    await expect(pom.unratedTags(EVENT.JOURNEY)).toBeVisible()

    // …and a rated entrant's rating NUMBER is not printed. Only the absence of a
    // rating is shown: the server judged every rated entrant against this event's
    // rules when they entered (eligibility lives in one place, ADR-0783), so their
    // number is noise — and eight numbers would bury the one chip that matters.
    await expect(pom.entrantsList(EVENT.JOURNEY)).not.toContainText('1450')
  })

  test('entering it myself adds a RATED chip — the mark follows the fact, not the newcomer', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await pom.enterButton(EVENT.JOURNEY).click()
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()

    // I am rated (1650), so my pinned chip is marked `(you)` and NOT `Unrated` —
    // while player.2's mark survives the refetch untouched. A mark keyed on
    // anything but the rating (recency, position, "not me") would swap here.
    await expect(pom.entrantItems(EVENT.JOURNEY).first()).toContainText(ME.username)
    await expect(pom.entrantItems(EVENT.JOURNEY).first()).toContainText('(you)')
    await expect(pom.entrantItems(EVENT.JOURNEY).first()).not.toContainText('Unrated')
    await expect(pom.unratedEntrantItems(EVENT.JOURNEY)).toHaveCount(1)
    await expect(pom.unratedEntrantItems(EVENT.JOURNEY)).toContainText('player.2')
  })

  test('an event in which EVERY entrant is unrated still renders its roster', async ({
    page,
  }) => {
    // The degenerate case, and the loophole at full stretch: a `rating < 1200` event
    // whose three entrants hold no rating at all — so all three passed the cap, and
    // the card marks all three. Meanwhile the same rule refuses ME, at 1650. Three
    // players the rules could not judge are in; the one they could judge is out.
    const { pom } = await TournamentDetailPage.navigateTo(page, { unrated: true })

    await expect(pom.entrantsList(EVENT.ALL_UNRATED)).toBeVisible()
    await expect(pom.entrantItems(EVENT.ALL_UNRATED)).toHaveCount(3)
    await expect(pom.unratedEntrantItems(EVENT.ALL_UNRATED)).toHaveCount(3)
    await pom.expectEntryCount(EVENT.ALL_UNRATED, 3, 32)

    // The roster is a roster, not an error or an empty state — every chip carries
    // the mark and the list renders exactly as it does with one.
    await expect(pom.eventCard(EVENT.ALL_UNRATED)).not.toContainText(COPY.emptyLead)

    // And it stays INERT: the mark is display, not a control. Withdrawing a ringer
    // is the director's action and it belongs to #991/#784 — not to this list, which
    // sits under the card's stretched open-target overlay.
    await expect(pom.cardButtons(EVENT.ALL_UNRATED)).toHaveCount(0)
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
    // …and the listed roster is a MIXED one (player.2 holds no rating), so the
    // unrated mark — new markup, and a contrast risk of its own — is inside this
    // scan rather than only inside an opt-in one.
    await expect(pom.unratedTags(EVENT.JOURNEY)).toBeVisible()

    await expectAxeClean(page, 'events tab before entering')
  })

  test('is axe-clean when EVERY entrant is unrated — a roster of nothing but marks', async ({
    page,
  }) => {
    // The mark's own worst case: every chip carries it. It is text inside a chip
    // inside a list item, tinted by the chip it sits in — so a contrast failure or a
    // broken list structure would be here, three chips over, and nowhere else.
    const { pom } = await TournamentDetailPage.navigateTo(page, { unrated: true })
    await expect(pom.unratedEntrantItems(EVENT.ALL_UNRATED)).toHaveCount(3)

    await expectAxeClean(page, 'events tab with an all-unrated roster')
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

  test('is axe-clean with the two REFUSED states on screen — full, and rating-ineligible', async ({
    page,
  }) => {
    // #783's two designed states: muted explanatory copy where a control used to
    // be. Assert both are really rendered before scanning — an axe pass over a page
    // that is missing the states it claims to cover is a green that means nothing.
    const { pom } = await TournamentDetailPage.navigateTo(page, { gated: true })
    await expect(pom.fullNotice(EVENT.FULL)).toBeVisible()
    await expect(pom.ineligibleNotice(EVENT.INELIGIBLE)).toBeVisible()

    await expectAxeClean(page, 'events tab with full and ineligible events')
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
