/**
 * The player profile and its match history, in a real browser (#1001, #1005,
 * #1003, #1006).
 *
 * There was **zero** e2e coverage of `/players/**` before this file — which is
 * precisely how four dead ends survived on the app's hub page. Each of them is a
 * claim only a browser can settle:
 *
 * - **#1001** the `notFound()` wiring. A missing player must reach the route's
 *   `notFoundComponent`, and a 5xx must reach its `errorComponent` — two
 *   different boundaries, mounted at two different points of TanStack's tree
 *   (`CatchBoundary(errorComponent) > CatchNotFound`). vitest can only exercise
 *   that indirectly; real routing is the only place the wiring is real.
 * - **#1005** the opponent links, asserted by *clicking* them and landing.
 * - **#1006** the match-history footer at a row count below one page.
 * - **#1003** the head-to-head empty state keeping its heading.
 *
 * plus the state the unit tests structurally cannot pin: the 5xx page is
 * **actually styled**. 1e's own verifier flagged the hole — the vitest test pins
 * a class-name contract, so a future swap to a different class that *also*
 * doesn't apply would keep it green while the page painted as naked text jammed
 * against the sidebar (the original #1001 complaint). Here the padding and the
 * display headline are read off `getComputedStyle`, so the CSS has to genuinely
 * apply.
 *
 * **MSW is OFF in this suite** (`playwright.config.ts` → `VITE_ENABLE_MSW:
 * 'false'`): the network is stubbed by `PlayerStore`'s inline `page.route`
 * interceptors, and those bodies are the only wire contract the browser sees.
 */
import { expect, test, type Page } from '@playwright/test'

import {
  expectAxeClean,
  expectAxeCleanExcept,
  type KnownAxeViolation,
} from '../support/axe'
import { PlayerProfilePage } from '../page-objects/players/player-profile.page'
import {
  API_SERVER_ERROR_DETAIL,
  HERON,
  OKAFOR,
  SILVA,
  UNKNOWN_PLAYER_ID,
} from '../page-objects/players/player-store'

/**
 * WCAG failures this coverage **found** rather than caused. Every one of them is
 * in code the four fixes never touched — note that is a claim about the *rules
 * these violations come from*, not about whole files: `player-profile.css` **was**
 * edited by this branch (2b/2c added the opponent-link styles), but nowhere near
 * `.head-to-head__cta`'s contrast or `.player-profile__table-wrap`'s overflow.
 * `form-chips.tsx` is untouched outright.
 *
 * The footer that slice 3 made unconditional is the one plausible way this branch
 * could have *caused* the scroll violation — by stealing vertical space from a
 * region whose CSS says it scrolls "so the hero and footer stay pinned". It did
 * not: the overflow is **horizontal**, and measures identically with the footer
 * removed (clientW 584 / scrollW 759, overflowY false, either way).
 *
 * They are the price of the page having had no e2e coverage at all: nothing was
 * ever scanning it.
 *
 * They are **not fixed here** — this chore's scope is the spec, and one of them
 * (the CTA's contrast) is a design-token decision, not a code one. They are
 * listed instead, node by node, so:
 *
 * - the new states this change *is* responsible for — the not-found page and the
 *   5xx error state — are held to a plain `expectAxeClean` with no exemptions;
 * - the pre-existing surfaces are still scanned, and still fail on **any** new
 *   violation, including a new node of a rule already listed.
 *
 * Delete an entry when the bug is fixed. Do not add one.
 */
const KNOWN_PROFILE_A11Y_DEBT: KnownAxeViolation[] = [
  {
    rule: 'aria-prohibited-attr',
    node: '.player-profile__form',
    owner:
      'form-chips.tsx renders a bare <span aria-label> — a generic element ' +
      'cannot carry an accessible name. The row-status dots elsewhere on this ' +
      'very page do it right (role="img" + aria-label).',
  },
  {
    rule: 'color-contrast',
    node: '.head-to-head__cta',
    owner:
      'player-profile.css: the Start-a-match CTA paints --bg-base text on a ' +
      '--ball-500 fill. A token-level decision, not a spec-level one.',
  },
  {
    rule: 'scrollable-region-focusable',
    node: '.player-profile__table-wrap',
    owner:
      'player-profile.css gives the match-history table wrap `overflow: auto` ' +
      'with no keyboard access — a keyboard user cannot scroll it.',
  },
]

/** The not-found body renders *inside* the `_app` layout, which already is an
 * `AppShell`. A component that wrapped itself in a second one would double every
 * landmark — a spike measured two `<main>`s from exactly that naive fix.
 *
 * **`<main>` is the load-bearing assertion, and it is the only one that can be an
 * exact count.** Below 960px the sidebar is a *drawer*: the `<aside>` is in the
 * DOM but out of the accessibility tree until the hamburger opens it, so a phone
 * legitimately exposes **zero** `complementary` landmarks. An earlier version of
 * this helper demanded exactly one and failed on the 375px run for a reason that
 * had nothing to do with app shells.
 *
 * So the sidebar gets a *ceiling*, not an equality. That still catches the bug
 * this guard exists for — a doubled shell renders two of everything, and two is
 * over the ceiling on either viewport — while staying true of a phone. */
async function expectExactlyOneAppShell(profile: PlayerProfilePage) {
  await expect(profile.mainLandmarks, 'one <main> landmark').toHaveCount(1)
  await expect(profile.headers, 'one topbar header').toHaveCount(1)
  expect(
    await profile.sidebars.count(),
    'never two sidebars (a phone exposes none — the nav is a drawer)',
  ).toBeLessThanOrEqual(1)
}

/** The designed not-found state, whichever route threw it. */
async function expectDesignedNotFound(page: Page, profile: PlayerProfilePage) {
  await expect(profile.notFoundHeading).toBeVisible()
  await expect(
    page.getByText(
      'No player with that id. The URL might be off, or they’ve been removed.',
    ),
  ).toBeVisible()

  // NOT the router's generic screen — which is where a render-thrown `notFound`
  // lands when the route declares no `notFoundComponent` of its own.
  await expect(profile.genericRouterError).toHaveCount(0)
  // NOT the error boundary. A missing player is a designed state, not an error.
  await expect(profile.errorState).toHaveCount(0)

  // The one recovery action, and it is a real link.
  await expect(profile.backToPlayersLink).toBeVisible()
  await expect(profile.backToPlayersLink).toHaveAttribute('href', '/players')

  await expectExactlyOneAppShell(profile)
}

test.describe('Player profile (desktop)', () => {
  /* ------------------------------------------------------------------ */
  /*  #1001 — the missing player                                        */
  /* ------------------------------------------------------------------ */

  test('an unknown player id renders the designed not-found inside ONE app shell', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(UNKNOWN_PLAYER_ID)

    await expectDesignedNotFound(page, profile)
    await expectAxeClean(page, 'player not-found')
  })

  test('"Back to players" actually navigates to the players list', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(UNKNOWN_PLAYER_ID)

    await profile.backToPlayersLink.click()

    await expect(page).toHaveURL(/\/players$/)
    // The list really rendered — a dead-end link that merely changed the URL
    // would still be a dead end.
    await expect(profile.playersListRow(OKAFOR.username)).toBeVisible()
  })

  test('the match-history sub-route 404s the same way — it is a separate boundary', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    // `/players/<unknown>/matches` is a sibling route, not a child: it does not
    // inherit the profile route's `notFoundComponent` and cannot fall back to
    // the router's default. Without its own, this is the generic error screen.
    await profile.openHistory(UNKNOWN_PLAYER_ID)

    await expectDesignedNotFound(page, profile)
    await expectAxeClean(page, 'player not-found (match-history sub-route)')
  })

  test('a malformed id gets the same designed not-found, with no validator string on screen', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile('abc')

    await expectDesignedNotFound(page, profile)
  })

  /* ------------------------------------------------------------------ */
  /*  #1001 — the other half: a 5xx is an ERROR, and stays retryable    */
  /* ------------------------------------------------------------------ */

  test('a 5xx renders a designed, genuinely-styled error state whose "Try again" works', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page, {
      failing: [OKAFOR.id],
    })
    await profile.openProfile(OKAFOR.id)

    await expect(profile.errorHeading).toBeVisible()
    // The regression the 404 change most endangers: a server error must NOT be
    // reported as a missing player.
    await expect(profile.notFoundHeading).toHaveCount(0)
    // And the server's own words never reach the reader.
    await expect(page.getByText(API_SERVER_ERROR_DETAIL)).toHaveCount(0)

    // It is *styled*, not merely present. This is the assertion the vitest test
    // structurally cannot make: it pins the class names, but a class name that
    // matches no rule (the original bug — `.empty*` is only defined under
    // `.match-list-page`) leaves the DOM identical and the page naked. Read the
    // computed style and the CSS has to actually apply.
    const box = profile.errorState
    await expect(box).toBeVisible()
    const padding = await box.evaluate((el) => {
      const s = getComputedStyle(el)
      return { top: s.paddingTop, left: parseFloat(s.paddingLeft) }
    })
    expect(padding.top, 'the error block has real padding').toBe('48px')
    expect(padding.left).toBeGreaterThanOrEqual(24)

    const titleSize = await profile.errorHeading.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    )
    expect(
      titleSize,
      'the headline is the display treatment, not 16px body text',
    ).toBeGreaterThanOrEqual(52)

    await expectExactlyOneAppShell(profile)
    await expectAxeClean(page, 'player 5xx error state')

    // Heal the route and drive the affordance: "Try again" must actually retry.
    profile.store.healProfile(OKAFOR.id)
    await profile.tryAgainButton.click()

    await expect(profile.heading(OKAFOR.username)).toBeVisible()
    await expect(profile.errorState).toHaveCount(0)
  })

  /* ------------------------------------------------------------------ */
  /*  #1005 — the opponent names are links                              */
  /* ------------------------------------------------------------------ */

  test('a frequent opponent’s name opens that player’s profile', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(OKAFOR.id)

    const link = profile.frequentOpponentLink(SILVA.username)
    await expect(link).toHaveAttribute('href', `/players/${SILVA.id}`)
    await link.click()

    await expect(page).toHaveURL(`/players/${SILVA.id}`)
    await expect(profile.heading(SILVA.username)).toBeVisible()
  })

  test('a Recent-matches opponent opens their profile; a solo match’s "No opponent" is not a link', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(OKAFOR.id)

    // The solo row: a name for an absence, so there is nobody to link to.
    const solo = profile.recentMatches.getByText('No opponent', { exact: true })
    await expect(solo).toBeVisible()
    await expect(
      profile.recentMatches.getByRole('link', { name: 'No opponent' }),
      'a solo match offers nothing to click',
    ).toHaveCount(0)
    await expect(
      page.locator('a[href*="/players/null"], a[href*="/players/undefined"]'),
      'the naive nullable-id fix would link here',
    ).toHaveCount(0)

    const link = profile.recentOpponentLink(SILVA.username)
    await expect(link).toHaveAttribute('href', `/players/${SILVA.id}`)
    await link.click()

    await expect(page).toHaveURL(`/players/${SILVA.id}`)
    await expect(profile.heading(SILVA.username)).toBeVisible()
  })

  /* ------------------------------------------------------------------ */
  /*  #1005 × #989 — a row is a match AND a person, so it has two links  */
  /* ------------------------------------------------------------------ */

  /*
   * The row link (#989) stretches its anchor's `::after` over every cell, and the
   * opponent's name (#1005) sits inside one of them. Left alone, the overlay wins
   * the hit-test and the name — still announced, still tabbable, still Enter-able
   * — is silently unclickable. `.match-row-inline-link` lifts it back out
   * (`match-row-link.css`).
   *
   * Nothing below can be caught in vitest: jsdom has no layout, so it cannot
   * hit-test, and a `toHaveAttribute('href')` assertion passes just as happily on
   * a link nobody can click. Only a real browser settles it — which is why these
   * live here, and why they click by *coordinate* rather than by locator.
   */

  const SOLO = 'No opponent'
  const OKAFOR_VS_SILVA = '/matches/aaaaaaaa-0000-4000-8000-000000000001'
  const OKAFOR_SOLO = '/matches/aaaaaaaa-0000-4000-8000-000000000002'

  test('Recent matches: the NAME opens the player, the rest of the row opens the match', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(OKAFOR.id)

    const row = profile.recentMatchRow(SILVA.username)
    // Two links, two destinations — each named for the one it actually goes to.
    await expect(row.getByRole('link')).toHaveCount(2)
    await expect(
      row.getByRole('link', { name: `Match against ${SILVA.username},` }),
    ).toHaveAttribute('href', OKAFOR_VS_SILVA)
    await expect(
      row.getByRole('link', { name: SILVA.username, exact: true }),
    ).toHaveAttribute('href', `/players/${SILVA.id}`)

    // Click the SCORE cell — no link of its own, so this can only be the row's
    // stretched anchor answering. It must be the match, not the profile.
    await profile.clickRowBody(row, 1)
    await expect(page).toHaveURL(OKAFOR_VS_SILVA)
  })

  test('Recent matches: a solo row’s "No opponent" is not clickable, and the row still opens the match', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(OKAFOR.id)

    const row = profile.recentMatchRow(SOLO)
    // One link only: there is nobody to link to, so the name stays plain text —
    // and emphatically not a link to `/players/null`.
    await expect(row.getByRole('link')).toHaveCount(1)
    await expect(row.getByRole('link', { name: SOLO })).toHaveCount(0)

    // Clicking the words "No opponent" is a click on the row, and the row is the
    // match. It must not be a dead spot, and it must not go to a player.
    await profile.clickRowBody(row, 0)
    await expect(page).toHaveURL(OKAFOR_SOLO)
  })

  test('Match history: the NAME opens the player, the rest of the row opens the match', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openHistory(OKAFOR.id)

    const row = profile.historyRow(SILVA.username)
    await expect(row.getByRole('link')).toHaveCount(2)
    await expect(profile.historyOpponentLink(SILVA.username)).toHaveAttribute(
      'href',
      `/players/${SILVA.id}`,
    )

    // The score cell (the third here: Date | Opponent | Score | Result).
    await profile.clickRowBody(row, 2)
    await expect(page).toHaveURL(OKAFOR_VS_SILVA)

    // …and the name really goes to the person.
    await profile.openHistory(OKAFOR.id)
    await profile.historyOpponentLink(SILVA.username).click()
    await expect(page).toHaveURL(`/players/${SILVA.id}`)
    await expect(profile.heading(SILVA.username)).toBeVisible()
  })

  test('Match history: a solo row’s "No opponent" is not clickable, and the row still opens the match', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openHistory(OKAFOR.id)

    const row = profile.historyRow(SOLO)
    await expect(row.getByRole('link')).toHaveCount(1)
    await expect(row.getByRole('link', { name: SOLO })).toHaveCount(0)
    await expect(
      page.locator('a[href*="/players/null"], a[href*="/players/undefined"]'),
      'the naive nullable-id fix would link here',
    ).toHaveCount(0)

    await profile.clickRowBody(row, 1) // the Opponent cell — the words themselves
    await expect(page).toHaveURL(OKAFOR_SOLO)
  })

  /* ------------------------------------------------------------------ */
  /*  #1003 — the head-to-head empty state keeps its heading            */
  /* ------------------------------------------------------------------ */

  test('a never-played player shows the invite, the CTA, and a LABELLED frequent-opponents section', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(HERON.id)

    const card = profile.headToHead
    await expect(
      card.getByText(`You haven’t played ${HERON.username} yet.`),
    ).toBeVisible()
    await expect(card.getByRole('link', { name: 'Start a match' })).toBeVisible()

    // The #1003 fix: the empty line lives INSIDE the labelled block, rather than
    // floating above the sub-heading as an orphan sentence that read as a
    // contradiction of the invite directly above it.
    const frequent = card.locator('.head-to-head__frequent')
    await expect(
      frequent.getByText(`${HERON.username}’s frequent opponents`),
    ).toBeVisible()
    await expect(
      frequent.getByText(`${HERON.username} hasn’t played anyone yet.`),
    ).toBeVisible()

    await expectAxeCleanExcept(
      page,
      'profile with an empty head-to-head',
      KNOWN_PROFILE_A11Y_DEBT,
    )
  })

  /* ------------------------------------------------------------------ */
  /*  #1006 — the match history at a low row count                      */
  /* ------------------------------------------------------------------ */

  test('a 2-match history shows "Showing 1–2 of 2 matches" and a disabled pager', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openHistory(OKAFOR.id)

    await expect(profile.footerInfo).toHaveText('Showing 1–2 of 2 matches')

    // The pager is there, and it is honestly disabled at a single page — the old
    // `total > PAGE_SIZE` guard rendered no footer and no pager at all.
    for (const name of ['First page', 'Previous page', 'Next page', 'Last page'] as const) {
      await expect(profile.pagerButton(name)).toBeDisabled()
    }

    // Exactly once. The section-header count chip the footer superseded is gone.
    await expect(page.locator('.player-profile__section-count')).toHaveCount(0)

    await expectAxeCleanExcept(page, 'player match history', KNOWN_PROFILE_A11Y_DEBT)
  })

  test('a 0-match history shows the designed empty state and NO footer or pager', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openHistory(HERON.id)

    await expect(profile.historyEmptyState).toBeVisible()
    // `total > 0`, not the old `total > PAGE_SIZE` coming back: at zero there is
    // nothing to page and nothing to count, so the empty state is the whole of it.
    await expect(page.locator('.footer')).toHaveCount(0)
    await expect(profile.pagerButton('Next page')).toHaveCount(0)

    await expectAxeCleanExcept(
      page,
      'empty player match history',
      KNOWN_PROFILE_A11Y_DEBT,
    )
  })

  /* ------------------------------------------------------------------ */
  /*  The happy path itself                                             */
  /* ------------------------------------------------------------------ */

  test('the loaded profile paints and is axe-clean', async ({ page }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(OKAFOR.id)

    await expect(profile.heading(OKAFOR.username)).toBeVisible()
    await expect(profile.headToHead).toBeVisible()
    await expect(profile.recentMatches).toBeVisible()
    await expect(
      profile.headToHead.getByText(`You’re 1–4 against ${OKAFOR.username}`),
    ).toBeVisible()

    await expectAxeCleanExcept(page, 'loaded player profile', KNOWN_PROFILE_A11Y_DEBT)
  })
})

/**
 * The phone. The profile is a single column at every width and the card order is
 * DOM order (ADR-0915), so the same links and the same boundaries have to work
 * here — and the not-found page's `clamp()`ed display type has to survive a
 * 375px column.
 */
test.describe('Player profile (mobile, 375px)', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('the profile loads, and an opponent’s name still opens their profile', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(OKAFOR.id)

    await expect(profile.heading(OKAFOR.username)).toBeVisible()

    await profile.frequentOpponentLink(SILVA.username).click()
    await expect(page).toHaveURL(`/players/${SILVA.id}`)
    await expect(profile.heading(SILVA.username)).toBeVisible()

    await expectAxeCleanExcept(
      page,
      'loaded player profile (mobile)',
      KNOWN_PROFILE_A11Y_DEBT,
    )
  })

  test('the 404 → Back-to-players journey works on a phone', async ({ page }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openProfile(UNKNOWN_PLAYER_ID)

    await expectDesignedNotFound(page, profile)
    await expectAxeClean(page, 'player not-found (mobile)')

    await profile.backToPlayersLink.click()
    await expect(page).toHaveURL(/\/players$/)
    await expect(profile.playersListRow(OKAFOR.username)).toBeVisible()
  })

  test('the match history still shows its count and pager on a phone', async ({
    page,
  }) => {
    const profile = await PlayerProfilePage.create(page)
    await profile.openHistory(OKAFOR.id)

    await expect(profile.footerInfo).toHaveText('Showing 1–2 of 2 matches')
    await expectAxeCleanExcept(
      page,
      'player match history (mobile)',
      KNOWN_PROFILE_A11Y_DEBT,
    )
  })
})
