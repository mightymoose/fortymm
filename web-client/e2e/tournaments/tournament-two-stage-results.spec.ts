/**
 * A **two-stage** (`rr-then-ko`) event's results (ADR 20260727) through the real browser:
 * the group standings above the bracket finishes, under a single champion banner naming
 * the **bracket's** winner.
 *
 * What only a browser proves here, and why the vitest suite could not:
 *
 *   1. **The real bundle parses the third arm.** `parseResults` throws on a `kind` it has no
 *      arm for, and that throw fails the whole tournament query — the error boundary, not a
 *      missing panel. vitest exercises the parser directly and the component against a
 *      hand-built view; this drives the served bundle against a stubbed wire payload, which
 *      is the only place a boundary/BFF mismatch on the new shape shows up.
 *
 *   2. **Both stages land on one card, in order, from ONE payload.** The composite selects
 *      each stage and hands it to the panel a pure round-robin / pure single-elim event
 *      already uses. A card that rendered only the stage the reader happened to look for
 *      would pass a weaker check.
 *
 *   3. **The champion is the bracket's, and there is exactly one banner.** `player.4` wins
 *      the final; `player.1` and `player.2` win the groups. A banner reading the top of a
 *      standings table would still *look* like a champion — so the assertion is the name,
 *      and the count.
 *
 *   4. **This whole surface runs with MSW OFF**, against the inline `page.route` stub.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT } from '../page-objects/tournaments/tournaments-store'

/** The two-stage seed with its draw cut and its bracket played out: six entrants, two
 * groups, two qualifying from each, a final decided. */
const PLAYED_OUT = {
  drawable: true,
  twoStage: true,
  drawn: [EVENT.TWO_STAGE],
  twoStageResults: 'complete',
} as const

test.describe('Tournaments · a two-stage (rr-then-ko) event’s results', () => {
  test('shows both groups’ standings above the bracket’s finishes, with one champion — the bracket’s', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, PLAYED_OUT)
    const event = EVENT.TWO_STAGE

    // Both stages, on one card.
    await expect(pom.standingsPanel(event)).toBeVisible()
    await expect(pom.finishesPanel(event)).toBeVisible()

    // The group stage: each group named, its rows joined to usernames, in the server's
    // finishing order. The memberships are the ones the snake dealt (groupIdFor('res-a'):
    // 1, 4, 5).
    await expect(pom.standingsRowNames(event, 'Group A')).toHaveText([
      'player.1',
      'player.4',
      'player.5',
    ])
    await expect(pom.standingsRowNames(event, 'Group B')).toHaveText([
      'player.2',
      'player.3',
      'player.6',
    ])

    // The knockout stage: single-elimination's own placement shape, ties and all — the two
    // beaten semifinalists share 3rd, one of them a group winner.
    await expect(pom.finishesRows(event)).toHaveText([
      /1st\s*player\.4/,
      /2nd\s*player\.1/,
      /T3\s*player\.2/,
      /T3\s*player\.3/,
    ])

    // ONE champion callout, and it names the FINAL's winner. `player.4` topped no group —
    // `player.1` and `player.2` did — so a banner reading the standings would say a
    // different name here and still look perfectly plausible.
    await expect(pom.twoStageChampion(event)).toBeVisible()
    await expect(pom.twoStageChampion(event)).toContainText('player.4')
    await expect(pom.championCallouts(event)).toHaveCount(1)

    expect(store.unhandled).toEqual([])
    await expect(pom.toasts).toHaveCount(0)
  })

  test('a MID-FLIGHT two-stage event shows its stages and crowns nobody', async ({
    page,
  }) => {
    // Groups decided, the final seated and unplayed. Both stages still render — the
    // standings in full, the finishes holding only the two entrants the bracket has
    // placed, starting at position 3 — and no banner appears, because nobody has won it
    // yet.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...PLAYED_OUT,
      twoStageResults: 'mid-flight',
    })
    const event = EVENT.TWO_STAGE

    await expect(pom.standingsRowNames(event, 'Group A')).toHaveText([
      'player.1',
      'player.4',
      'player.5',
    ])
    await expect(pom.finishesRows(event)).toHaveText([
      /T3\s*player\.2/,
      /T3\s*player\.3/,
    ])
    await expect(pom.championCallouts(event)).toHaveCount(0)
  })

  test('a viewer sees both stages too — results are public', async ({ page }) => {
    // Read-only for everyone: a non-owner sees the same two stages and the same champion,
    // and the block carries no control for either of them.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...PLAYED_OUT,
      canEdit: false,
    })
    const event = EVENT.TWO_STAGE

    await expect(pom.standingsPanel(event)).toBeVisible()
    await expect(pom.finishesPanel(event)).toBeVisible()
    await expect(pom.twoStageChampion(event)).toContainText('player.4')
  })
})
