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
 *   2. **The 409 reaches a human.** The mutation toasts on error; a toast is a
 *      portal, rendered outside the page's tree, on top of the layout, and gone
 *      in four seconds. That it is genuinely *visible* — and that the refused
 *      view then corrects itself instead of freezing on the render the 409
 *      disproved — is a claim about the live DOM.
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
import { EVENT, ME, STATUSES } from '../page-objects/tournaments/tournaments-store'
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
    // THE assertion, half one: the user is TOLD. A silent 409 would leave them
    // clicking a button that does nothing, forever.
    await expect(pom.toasts).toHaveCount(1)
    await expect(pom.toasts).toContainText("Couldn't publish the tournament")

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

    // It raised no error of its own. Asserted as "no toast bearing THIS verb"
    // rather than "still exactly one toast": the refusal above dismisses itself
    // after a few seconds, so a total count here would be a race against a
    // countdown — green locally and flaky on a loaded runner.
    await expect(
      pom.toasts.filter({ hasText: "Couldn't start the tournament" }),
    ).toHaveCount(0)
    expect(store.countOf('POST')).toBe(2) // the refused publish, then the accepted start
  })
})

test.describe('Tournaments · the registration window', () => {
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
  // Every status, because a header that leaked a button in exactly one of them
  // would be a viewer clicking Publish on somebody else's tournament — a 403 they
  // were invited to earn. (Hiding it is UX; the API 403s independently.)
  for (const status of STATUSES) {
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

  test('is axe-clean with the refusal toast on screen', async ({ page }) => {
    // The error state is a state, and it is the one most likely to be missed: the
    // toast is a portal outside the page's tree, over the top of everything else.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      status: 'draft',
    })
    store.transitionElsewhere('published')
    await pom.lifecycleButton('Publish').click()

    const toast = pom.toasts.first()
    await expect(toast).toBeVisible()
    // Sonner dismisses after a few seconds and pauses that timer while the toaster
    // is hovered — so hover, rather than race the scan against the countdown. (The
    // assertion after the scan is what keeps this honest: if the pause ever stops
    // working, the toast is gone and this test fails loudly instead of quietly
    // scanning a page without it.)
    await toast.hover()

    await expectAxeClean(page, 'tournament detail — refused transition toast')
    await expect(toast).toBeVisible()
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
