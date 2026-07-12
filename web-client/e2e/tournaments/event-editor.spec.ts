/**
 * The event editor's rule builder, and what it does when a save is refused (#783
 * QA). Two bugs, one root cause: the builder validated nothing, and the editor
 * heard nothing back.
 *
 * What only a browser can prove here:
 *
 *   1. **Nothing is sent.** The component test asserts an `onSave` spy was not
 *      called; that is a claim about a prop. This asserts no request left the page —
 *      the store counts every POST and PATCH it sees, so a builder that "showed an
 *      error" while also firing the write would fail here and pass there.
 *
 *   2. **The work survives a 422.** The data-loss bug in full: type a rule, get
 *      refused, and watch the sheet close and take everything with it. Whether the
 *      sheet is still open, still holds the draft, and now says why, is a claim
 *      about the live DOM after a real (stubbed) 422 — and the editor's write
 *      endpoints were UNMOCKED in this suite until now, which is precisely why no
 *      spec had ever watched one come back.
 *
 *   3. **`Rating < ?` never reaches the card.** The chip is what the organizer sees
 *      afterwards, on a different component, off a refetch.
 *
 *   4. **axe-clean with the form in its error state** — new red markup, in a portal,
 *      that jsdom cannot see the contrast of.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT } from '../page-objects/tournaments/tournaments-store'
import { expectAxeClean } from '../support/axe'

/** The form's messages, hard-coded test-side (as the lifecycle spec's notices are):
 * importing them from `data/predicate-validation` would make every assertion below
 * pass whatever the copy became. */
const SAY = {
  empty: 'Enter a rating.',
  inverted: 'The upper bound must be at least the lower bound.',
  range: 'Rating must be 0–3000.',
} as const

/** Longer than the `VARCHAR(255)` the server allows — the 422 QA watched the editor
 * swallow. */
const TOO_LONG = 'A'.repeat(256)

/**
 * ⚠️ **A pre-existing violation, and not this change's to fix.** The shared
 * `Button variant="destructive"` (`.bg-destructive` + white text,
 * `src/components/ui/button.tsx`) fails AA colour contrast, and the event editor's
 * "Delete event" is one of them — so *any* scan with the editor open trips on it.
 * This spec is simply the first thing in the suite ever to open the editor and scan.
 *
 * It is a design-system defect on every destructive button in the app, its fix is a
 * shared token (and a re-cut of the design-system snapshot baselines), and it has
 * nothing to do with a rule builder that validated nothing. Excluded here — named,
 * not hidden — so these scans say something about the states this spec actually adds:
 * the red field messages and the refusal alert. **Follow-up ticket.**
 */
const KNOWN_DESTRUCTIVE_BUTTON_CONTRAST = ['.bg-destructive']

test.describe('Tournaments · the eligibility rule builder', () => {
  test('a between rule with NO bounds is refused in the form — no request, no lost work', async ({
    page,
  }) => {
    // QA's exact steps: add a rule, set the operator to "is between", leave both
    // bounds empty, press Save. It used to send that, take a 422, and close.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await expect(pom.eventEditor).toBeVisible()

    await pom.editorTab('Eligibility').click()
    await pom.addRuleButton.click()
    await pom.chooseOperator('is between')
    await expect(pom.ruleLowerBound).toHaveValue('')
    await expect(pom.ruleUpperBound).toHaveValue('')

    await pom.saveEventButton.click()

    // Told, in the form, under the boxes that are empty.
    await expect(pom.ruleErrors).toHaveCount(1)
    await expect(pom.ruleErrors.first()).toHaveText(SAY.empty)
    await expect(pom.ruleLowerBound).toHaveAttribute('aria-invalid', 'true')
    await expect(pom.ruleUpperBound).toHaveAttribute('aria-invalid', 'true')

    // THE assertion: the editor is still here, and NOTHING was sent. Not a request
    // that was sent and whose answer was ignored — none at all.
    await expect(pom.eventEditor).toBeVisible()
    expect(store.countOf('PATCH')).toBe(0)
    expect(store.countOf('POST')).toBe(0)
    // …and no toast either: a field error is a field error (`CLAUDE.md`, `## Forms`).
    await expect(pom.toasts).toHaveCount(0)
  })

  test('INVERTED bounds are refused, and the fixed rule then saves and reaches the card', async ({
    page,
  }) => {
    // `Rating in [1600–1200]` saved happily before this. No player can satisfy it.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await pom.editorTab('Eligibility').click()
    await pom.addRuleButton.click()
    await pom.chooseOperator('is between')
    await pom.ruleLowerBound.fill('1600')
    await pom.ruleUpperBound.fill('1200')

    await pom.saveEventButton.click()

    await expect(pom.ruleErrors.first()).toHaveText(SAY.inverted)
    await expect(pom.eventEditor).toBeVisible()
    expect(store.countOf('PATCH')).toBe(0)

    // The positive control — without it, "the builder refuses things" could be true
    // of a builder that refuses everything. Fix the rule and it goes.
    await pom.ruleUpperBound.fill('1800')
    await expect(pom.ruleErrors).toHaveCount(0)

    await pom.saveEventButton.click()

    // Saved: the editor closes on success (and ONLY on success), the request landed,
    // and the rule is on the card — as a real rule, with both its bounds.
    await expect(pom.eventEditor).toBeHidden()
    expect(store.countOf('PATCH')).toBe(1)
    await expect(pom.eventCard(EVENT.JOURNEY)).toContainText('Rating in [1600–1800]')
    expect(store.unhandled).toEqual([])
  })

  test('an EMPTY scalar value never reaches the card as `Rating < ?`', async ({
    page,
  }) => {
    // This one used to SAVE (201) — the API accepts a null-valued rule on purpose (a
    // half-written rule constrains nobody) — and the card then printed the chip
    // `Rating < ?`: a rule restricting no one, rendered as though it were real. The
    // guard has to be here, in the client, because the server is not going to do it.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await pom.editorTab('Eligibility').click()
    await pom.addRuleButton.click()
    await pom.ruleValue.fill('')

    await pom.saveEventButton.click()

    await expect(pom.ruleErrors.first()).toHaveText(SAY.empty)
    expect(store.countOf('PATCH')).toBe(0)
    await expect(pom.eventEditor).toBeVisible()

    // Nowhere near the card — not before the save, and not after a save that never
    // happened.
    await expect(pom.eventCard(EVENT.JOURNEY)).not.toContainText('?')
  })

  test('a rating out of range is refused', async ({ page }) => {
    // `Rating < 999999999` saved. A rating is a rating: 0–3000.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await pom.editorTab('Eligibility').click()
    await pom.addRuleButton.click()
    await pom.ruleValue.fill('999999999')

    await pom.saveEventButton.click()

    await expect(pom.ruleErrors.first()).toHaveText(SAY.range)
    expect(store.countOf('PATCH')).toBe(0)
  })
})

test.describe('Tournaments · a save the server refuses', () => {
  test('a 422 keeps the editor OPEN, keeps the draft, and says what happened', async ({
    page,
  }) => {
    // The half that matters most. Client validation stops the refusals we know
    // about; this is what stops the next unknown one from eating someone's work.
    // Here the unknown one is an over-long name — QA's second silent discard.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await pom.eventNameInput.fill(TOO_LONG)

    await pom.saveEventButton.click()

    // The request really was made and really was refused — this is not the form
    // guarding again.
    await expect(pom.saveFailure).toBeVisible()
    expect(store.countOf('PATCH')).toBe(1)
    expect(store.unhandled).toEqual([])

    // The server's own words about their event…
    await expect(pom.saveFailure).toContainText(
      'String should have at most 255 characters',
    )
    // …and the promise the old editor broke.
    await expect(pom.saveFailure).toContainText('your changes are still here')

    // THE assertion: still open, still holding every character they typed.
    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventNameInput).toHaveValue(TOO_LONG)

    // And it is a *recoverable* state, not a dead end: shorten the name and the
    // very same button saves.
    await pom.eventNameInput.fill('Open Singles B')
    await pom.saveEventButton.click()

    await expect(pom.eventEditor).toBeHidden()
    expect(store.countOf('PATCH')).toBe(2)
    await expect(pom.eventCard('Open Singles B')).toBeVisible()
  })

  test('a refused CREATE keeps the new event on screen rather than binning it', async ({
    page,
  }) => {
    // The worst version of the bug: a brand-new event, refused, closed — and there
    // was nothing left anywhere to recover it from.
    const { pom, store } = await TournamentDetailPage.navigateTo(page)

    await pom.newEventButton.click()
    await expect(pom.eventEditor).toBeVisible()
    await pom.eventNameInput.fill(TOO_LONG)

    await pom.saveEventButton.click()

    await expect(pom.saveFailure).toContainText("Couldn't create this event")
    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventNameInput).toHaveValue(TOO_LONG)
    expect(store.countOf('POST')).toBe(1)
  })
})

test.describe('Tournaments · the event editor · accessibility', () => {
  test('is axe-clean with the rule builder in its error state', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await pom.editorTab('Eligibility').click()
    await pom.addRuleButton.click()
    await pom.chooseOperator('is between')
    await pom.saveEventButton.click()

    // Prove the state is really on screen before scanning it — an axe pass over a
    // page that never reached the state is a green that means nothing.
    await expect(pom.ruleErrors.first()).toBeVisible()

    await expectAxeClean(page, 'event editor — invalid eligibility rule', {
      exclude: KNOWN_DESTRUCTIVE_BUTTON_CONTRAST,
    })
  })

  test('is axe-clean with the server refusal on screen', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditorOverlay(EVENT.JOURNEY).click()
    await pom.eventNameInput.fill(TOO_LONG)
    await pom.saveEventButton.click()

    await expect(pom.saveFailure).toBeVisible()

    await expectAxeClean(page, 'event editor — refused save', {
      exclude: KNOWN_DESTRUCTIVE_BUTTON_CONTRAST,
    })
  })
})
