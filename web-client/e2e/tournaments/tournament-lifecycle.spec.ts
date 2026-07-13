/**
 * The tournament lifecycle and the registration window it opens and shuts
 * (ADR-0017), through the real browser.
 *
 *     draft ──Publish──▶ published ──Start──▶ live ──End──▶ archived
 *
 * What only a browser can prove here, and why each of these is not already
 * settled by the vitest suite:
 *
 *   1. **The walk is a walk.** The component tests each render one status and
 *      assert one button. Nothing below the browser ever *clicks* Publish and
 *      then reads the badge — i.e. nothing proves the four renders are the same
 *      tournament moving, rather than four unrelated screenshots. Every step here
 *      is the mutation's own refetch coming back and re-deciding the header.
 *
 *   2. **The 409 reaches a human.** The refusal is rendered inline, in the header,
 *      beside the button that was clicked (#786 — the go-live refusal's sentence
 *      names the events whose draws are missing or stale, and a work list must not
 *      evaporate after four seconds like a toast). That it is genuinely *visible*,
 *      that it does not double up with a toast, and that the refused view then
 *      corrects itself instead of freezing on the render the 409 disproved — all
 *      claims about the live DOM.
 *
 *   3. **Header and card move together.** The status decides two things a screen
 *      apart: which button the header offers, and what the event card's entry
 *      control is. Publishing must open the window and starting must lock it, in
 *      one page, off one refetch.
 *
 *   4. **axe-clean in each of the four statuses**, including the two new designed
 *      states (the not-open-yet notice and the entries-locked notice) and the
 *      error toast — a live-page concern (contrast, focus, hidden-focusable) that
 *      jsdom cannot see.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import {
  ANNOUNCED_STATUSES,
  EVENT,
  ME,
  STATUSES,
} from '../page-objects/tournaments/tournaments-store'
import { expectAxeClean } from '../support/axe'

/** The registration window's copy, hard-coded test-side (as the roster copy in
 * `event-entry.spec.ts` is): importing it from `data/lifecycle` would make every
 * assertion below pass whatever the copy became. */
const NOTICE = {
  draft: {
    lead: 'Not open yet',
    reason: 'Entry opens when this tournament is published.',
  },
  live: { lead: 'Entries locked', reason: 'The tournament is under way.' },
  archived: { lead: 'Entries locked', reason: 'The tournament has ended.' },
} as const

test.describe('Tournaments · the lifecycle', () => {
  test('the owner walks draft → published → live → archived, one edge at a time', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'draft',
    })

    // Each step: click the ONE button this status offers, and watch the badge and
    // the button both become what the next status offers. `expectLifecycle`
    // asserts the count too, so a header that started stacking buttons up as it
    // went would fail here rather than pass on "the one I asked for is present".
    await pom.expectLifecycle('Draft', 'Publish')

    await pom.lifecycleButton('Publish').click()
    await pom.expectLifecycle('Published', 'Start tournament')

    await pom.lifecycleButton('Start tournament').click()
    await pom.expectLifecycle('Live', 'End tournament')

    await pom.lifecycleButton('End tournament').click()
    // `archived` is terminal: no edge out of it, so no button — not a disabled
    // one. This is the assertion that would fail if the header ever went back to
    // offering all three.
    await pom.expectLifecycle('Archived', 'none')

    // The server walked with us: three transitions, no patches, and it really is
    // archived — the badge is not just a client-side optimism.
    expect(store.status).toBe('archived')
    expect(store.countOf('POST')).toBe(3)
    expect(store.countOf('PATCH')).toBe(0)
    // A clean walk raises nothing: every edge we offered was one the server has.
    await expect(pom.toasts).toHaveCount(0)
    expect(store.unhandled).toEqual([])
  })

  test('publishing OPENS the entry window and starting the tournament LOCKS it — with my entry still on the roster', async ({
    page,
  }) => {
    // The lifecycle and the registration window are one thing read from two ends
    // (ADR-0017), and this is the only test in the repo that watches both ends of
    // it move at once, on one page, off one refetch.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'draft',
    })
    const card = pom.eventCard(EVENT.JOURNEY)

    // --- draft: the door is not open yet -------------------------------------
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.draft.lead,
    )
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.draft.reason,
    )
    await expect(pom.enterButton(EVENT.JOURNEY)).toHaveCount(0)

    // --- publish: the door opens ---------------------------------------------
    await pom.lifecycleButton('Publish').click()

    await expect(pom.enterButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toHaveCount(0)

    // …and it is a real door, not a picture of one: entering works.
    await pom.enterButton(EVENT.JOURNEY).click()
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText(ME.username)
    await pom.expectEntryCount(EVENT.JOURNEY, 3, 64)

    // --- go live: the door shuts, with me inside ------------------------------
    await pom.lifecycleButton('Start tournament').click()

    // THE assertion of this slice's subtlest case. I am still an entrant — the
    // field is fixed, which is what going live MEANS — so my chip stays on the
    // roster and the count stays at 3. What I lose is the ability to take myself
    // out of it: Withdraw is gone, replaced by the lock, not by silence and not
    // by a disabled button.
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toHaveCount(0)
    await expect(pom.enterButton(EVENT.JOURNEY)).toHaveCount(0)
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.live.lead,
    )
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.live.reason,
    )
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText(ME.username)
    await pom.expectEntryCount(EVENT.JOURNEY, 3, 64)
    await expect(card).toContainText('(you)')

    // --- end it: the lock's reason changes tense -----------------------------
    // "under way" and "has ended" are two states, not one "closed": a player who
    // arrives late is owed the difference.
    await pom.lifecycleButton('End tournament').click()

    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.archived.reason,
    )
    expect(store.entrantsOf(EVENT.JOURNEY).map((e) => e.username)).toContain(
      ME.username,
    )
    await expect(pom.toasts).toHaveCount(0)
  })

  test('a REFUSED transition (409) tells the user, and the stale view corrects itself', async ({
    page,
  }) => {
    // The director has this tournament open here, and published it from their
    // phone. This page still shows a draft: badge "Draft", button "Publish".
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'draft',
    })
    await pom.expectLifecycle('Draft', 'Publish')

    store.transitionElsewhere('published')

    // Still stale — the page has not refetched behind our backs, so the click
    // below really is the stale one (if it had, this test would prove nothing).
    await pom.expectLifecycle('Draft', 'Publish')

    // --- click the button that names an edge which no longer exists -----------
    await pom.lifecycleButton('Publish').click()

    // The server refuses it: `published → published` is not an edge, it is a
    // conflict (ADR-0017 — "the only caller that sends it is a stale one").
    //
    // THE assertion, half one: the user is TOLD — inline, beside the button they
    // clicked, in an `Alert` the mutation no longer duplicates with a toast (#786:
    // the same surface carries go-live's refusal, whose sentence is a work list and
    // has no business disappearing after four seconds). A silent 409 would leave them
    // clicking a button that does nothing, forever.
    await expect(pom.lifecycleNotice).toBeVisible()
    await expect(pom.lifecycleNotice).toContainText(
      "Couldn't publish the tournament",
    )
    // Told once, not twice: the inline notice REPLACED the toast, it did not join it
    // (`web-client/CLAUDE.md`, ## Forms).
    await expect(pom.toasts).toHaveCount(0)

    // …and told something USEFUL. This click is a self-transition
    // (`published → published`), which is what a stale tab always produces — and
    // the two-ended phrasing degenerates into tautology exactly there ("this
    // tournament is published; it cannot be moved to published"), which tells the
    // director nothing. The sentence they need is the fact that somebody already
    // did it, so pin the sentence, not just the verb: the title alone would go
    // green against the tautology this copy replaced.
    await expect(pom.lifecycleNotice).toContainText(
      'This tournament is already published.',
    )

    // …and told it by a 409, not by an accident. Without this line the test would
    // pass just as happily if the transitions route were UNMOCKED: the 404 would
    // raise the same toast, and the refetch would reconcile the view all the same.
    expect(store.unhandled).toEqual([])

    // THE assertion, half two: the view reconciles. The refused tab does NOT sit
    // frozen on the render the 409 disproved — it re-reads the tournament and now
    // shows the truth, and therefore stops offering the very button it was just
    // refused. It offers the one that IS legal now.
    await pom.expectLifecycle('Published', 'Start tournament')

    // …and the corrected view is a WORKING one, not a picture: the edge it now
    // offers is one the server accepts.
    await pom.lifecycleButton('Start tournament').click()
    await pom.expectLifecycle('Live', 'End tournament')
    expect(store.status).toBe('live')

    // It raised no error of its own — and the refusal from the click before it is
    // GONE, cleared when the next attempt started: a notice about the click before
    // last is worse than none.
    await expect(pom.lifecycleNotice).toHaveCount(0)
    await expect(pom.toasts).toHaveCount(0)
    expect(store.countOf('POST')).toBe(2) // the refused publish, then the accepted start
  })
})

test.describe('Tournaments · the registration window', () => {
  test('a stale ENTER is told the window SHUT — not that they already entered', async ({
    page,
  }) => {
    // The player's half of the two-tab race. They have this published tournament
    // open and are looking at an **Enter** button; the director starts the
    // tournament from their own tab. The button on this page now names a request
    // the server refuses — with a 409, the SAME status code a duplicate entry
    // earns, which is why the client used to read this as "you already entered"
    // and tell the player something that is simply false: they are not entered,
    // and from here they cannot be.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'published',
    })
    await expect(pom.enterButton(EVENT.EMPTY)).toBeVisible()

    store.transitionElsewhere('live')

    // Still stale — the page has not refetched behind our backs, so the click
    // below really is the stale one.
    await expect(pom.enterButton(EVENT.EMPTY)).toBeVisible()

    await pom.enterButton(EVENT.EMPTY).click()

    // THE assertion, half one: the truth, in the tense the tournament is actually
    // in. Not "You were already entered in this event".
    await expect(pom.toasts).toHaveCount(1)
    await expect(pom.toasts).toContainText('Entries are closed for this event')
    // Both lines are the CLIENT's copy, keyed off the refusal's `code` (ADR-0968).
    // The server's sentence ("This tournament is already under way, so its entries
    // are locked.") is a fallback the client never has to reach for here — raw API
    // detail strings do not reach the UI — and the reconciled card below is what
    // names the status the tournament is actually in now.
    await expect(pom.toasts).toContainText(
      "This tournament's registration window is shut",
    )
    await expect(pom.toasts).not.toContainText('already entered')

    // …and it was a 409 from the entries route, not an accident of an unmocked
    // call falling through to a 404.
    expect(store.unhandled).toEqual([])

    // THE assertion, half two: the view reconciles, so the refusal and the screen
    // agree — the button that was just refused is gone, replaced by the lock, and
    // the player is genuinely NOT on the roster.
    await expect(pom.enterButton(EVENT.EMPTY)).toHaveCount(0)
    await expect(pom.registrationNotice(EVENT.EMPTY)).toContainText(
      NOTICE.live.lead,
    )
    await expect(pom.withdrawButton(EVENT.EMPTY)).toHaveCount(0)
    expect(store.entrantsOf(EVENT.EMPTY)).toEqual([])
    await pom.expectEntryCount(EVENT.EMPTY, 0, 48)
  })

  test('a DRAFT tournament says entry is not open yet, and offers no Enter', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'draft',
    })

    await expect(pom.statusBadge).toHaveText('Draft')
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.draft.lead,
    )
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.draft.reason,
    )
    // Absent, not disabled: a button whose only possible answer is a 409 is an
    // unexplained dead end (ADR-0015).
    await expect(pom.enterButton(EVENT.JOURNEY)).toHaveCount(0)
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toHaveCount(0)

    // The card is otherwise entirely alive — the roster, the count, the editor.
    // "Closed" is a state of the window, not of the page.
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText('player.1')
    await pom.expectEntryCount(EVENT.JOURNEY, 2, 64)
    expect(store.countOf('POST')).toBe(0)
  })

  test('a PUBLISHED tournament is the one that opens the window', async ({ page }) => {
    // The positive control for the three refusals: without it, "no Enter button"
    // could be true of every status for a reason that has nothing to do with the
    // lifecycle at all.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      status: 'published',
    })

    await expect(pom.statusBadge).toHaveText('Published')
    await expect(pom.enterButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toHaveCount(0)
  })

  test('a LIVE tournament locks entries — an ENTERED player sees the lock, not Withdraw, and stays on the roster', async ({
    page,
  }) => {
    // Seeded already-in, because entering a live tournament is (rightly) refused:
    // this is the player who entered while the window was open and then watched
    // the director start play.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'live',
      enteredIn: [EVENT.JOURNEY],
    })

    await expect(pom.statusBadge).toHaveText('Live')

    // I am in it — the server says so, and the card says so.
    expect(store.entrantsOf(EVENT.JOURNEY).map((e) => e.username)).toContain(
      ME.username,
    )
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText(ME.username)
    await pom.expectEntryCount(EVENT.JOURNEY, 3, 64)

    // …and I cannot take myself out of it. The window is judged BEFORE membership,
    // which is the whole reason this comes out `locked` rather than `withdraw`.
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toHaveCount(0)
    await expect(pom.enterButton(EVENT.JOURNEY)).toHaveCount(0)
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.live.lead,
    )
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.live.reason,
    )

    // An event I never entered locks the same way — the lock is a fact about the
    // tournament, not about me.
    await expect(pom.registrationNotice(EVENT.EMPTY)).toContainText(
      NOTICE.live.lead,
    )
  })

  test('an ARCHIVED tournament says it has ended', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      status: 'archived',
      enteredIn: [EVENT.JOURNEY],
    })

    await expect(pom.statusBadge).toHaveText('Archived')
    await expect(pom.enterButton(EVENT.JOURNEY)).toHaveCount(0)
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toHaveCount(0)

    // The past tense, not the present one: `live` and `archived` are both "locked"
    // and they are not the same news.
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toContainText(
      NOTICE.archived.reason,
    )
    await expect(pom.registrationNotice(EVENT.JOURNEY)).not.toContainText(
      NOTICE.live.reason,
    )
    await expect(pom.entrantsList(EVENT.JOURNEY)).toContainText(ME.username)
  })
})

test.describe('Tournaments · a viewer who does not own the tournament', () => {
  // Every status a viewer can actually SEE, because a header that leaked a button
  // in exactly one of them would be a viewer clicking a transition on somebody
  // else's tournament — a 403 they were invited to earn. (Hiding it is UX; the API
  // 403s independently.)
  //
  // Announced-only, not all four (#967): somebody else's DRAFT is not a page a
  // viewer can be on. The API hides an unannounced tournament from everyone but its
  // creator — its detail GET is a 404, deliberately, so a hidden draft is
  // indistinguishable from one that never existed — so a viewer-on-a-draft spec
  // would stub a response the server will not send and assert the UI behaves in a
  // state it cannot reach. The 404 is the real behaviour there, and it belongs to
  // the not-found screen, not to this sweep.
  for (const status of ANNOUNCED_STATUSES) {
    test(`sees the ${status} badge and NO lifecycle button`, async ({ page }) => {
      const { pom, store } = await TournamentDetailPage.navigateTo(page, {
        status,
        canEdit: false,
      })

      // The page is fully there — so the absence below is an absence of the
      // buttons, not of the page.
      await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
      await expect(pom.statusBadge).toBeVisible()
      await expect(pom.statusBadge).toHaveAttribute('data-status', status)

      await expect(pom.anyLifecycleButton).toHaveCount(0)
      expect(store.countOf('POST')).toBe(0)
    })
  }
})

test.describe('Tournaments · the lifecycle · accessibility', () => {
  for (const status of STATUSES) {
    test(`is axe-clean in the ${status} status`, async ({ page }) => {
      // Every status puts a different thing on screen: a different lifecycle
      // button in the header (or none), and — for the three closed ones — the
      // registration notice on every card, which is new markup in a slot that
      // used to hold a button.
      const { pom } = await TournamentDetailPage.navigateTo(page, {
        status,
        enteredIn: status === 'published' ? [] : [EVENT.JOURNEY],
      })

      // Prove the state is really rendered before scanning it: an axe pass over a
      // page that has not reached the state is a green that means nothing.
      await expect(pom.statusBadge).toHaveAttribute('data-status', status)
      if (status === 'published') {
        await expect(pom.enterButton(EVENT.JOURNEY)).toBeVisible()
      } else {
        await expect(pom.registrationNotice(EVENT.JOURNEY)).toBeVisible()
      }

      await expectAxeClean(page, `tournament detail — ${status}`)
    })
  }

  test('is axe-clean with the refusal notice on screen', async ({ page }) => {
    // The error state is a state, and it is the one most likely to be missed. It is
    // now IN the page — an `Alert` in the header, beside the button (#786) — rather
    // than a toast portalled over the top of it, so the scan has to reach it where it
    // actually lives: contrast against the hero, and a live region a screen reader
    // hears without hunting for it.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'draft',
    })
    store.transitionElsewhere('published')
    await pom.lifecycleButton('Publish').click()

    // Prove the state is really rendered before scanning it: an axe pass over a page
    // that has not reached the state is a green that means nothing. (And unlike the
    // toast this replaced, it does not dismiss itself — there is no countdown to race.)
    await expect(pom.lifecycleNotice).toBeVisible()

    await expectAxeClean(page, 'tournament detail — refused transition notice')
    await expect(pom.lifecycleNotice).toBeVisible()
  })

  test('is axe-clean for a viewer, who is offered no lifecycle button at all', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      status: 'live',
      canEdit: false,
      enteredIn: [EVENT.JOURNEY],
    })
    await expect(pom.anyLifecycleButton).toHaveCount(0)
    await expect(pom.registrationNotice(EVENT.JOURNEY)).toBeVisible()

    await expectAxeClean(page, 'tournament detail — viewer, live')
  })
})
