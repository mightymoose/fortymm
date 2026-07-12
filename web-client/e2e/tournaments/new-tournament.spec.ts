/**
 * The "New tournament" dialog, and what it says when the server refuses (#783 QA,
 * round two — the event editor's sibling).
 *
 * The dialog did `form.setError('name', { message: err.detail })`, so a 422 printed
 * **Pydantic's** own sentence under the name box: "String should have at most 255
 * characters" — the wire's vocabulary, naming a type constraint, in a dialog about a
 * tournament. `DEFINITION_OF_COMPLETE.md`: *"Raw API detail strings never reach the
 * UI."*
 *
 * What only a browser can prove here:
 *
 *   1. **The string is nowhere on the page.** A component test asserts what one
 *      locator says; this asserts what the whole rendered document does not contain —
 *      banner, field hint, toast and all.
 *   2. **The entry survives.** The dialog is still open, still holding what was typed,
 *      and now says why — after a real (stubbed) 422 off the real fetch stack, with
 *      MSW off.
 *   3. **Nothing is sent** for the constraints the form does mirror (an over-long
 *      name): the store counts every POST it sees.
 *   4. **axe-clean in the error state** — red markup inside a portalled dialog, whose
 *      contrast jsdom cannot see.
 */
import { expect, test } from '@playwright/test'

import { TournamentsListPage } from '../page-objects/tournaments/tournaments-list.page'
import { expectAxeClean } from '../support/axe'

/** The dialog's messages, hard-coded test-side (as the editor spec's are): importing
 * them from `data/save-failure` would make every assertion below pass whatever the
 * copy became. */
const SAY = {
  nameRequired: 'Name is required.',
  nameTooLong: 'Name must be 255 characters or fewer.',
  /** Ours, for the residual 422 — see `PYDANTIC` below. */
  refusedName: 'The Name was rejected. Check that field and try again.',
} as const

/** ⚠️ The string that must NEVER appear on screen: what FastAPI really answers with,
 * which the stub sends (because the server does) and which this dialog used to print
 * verbatim under the box. */
const PYDANTIC = 'String should have at most 255 characters'

/** Longer than the `VARCHAR(255)` the server allows. It no longer *reaches* the
 * server — the form mirrors that constraint — so it proves the other half: nothing is
 * sent. */
const TOO_LONG = 'A'.repeat(256)

/** @see the same exclusion in `event-editor.spec.ts`: `Button variant="destructive"`
 * fails AA contrast app-wide (a design-system token defect, its own ticket). The
 * tournament cards behind the dialog render one, so any scan of this page trips on it. */
const KNOWN_DESTRUCTIVE_BUTTON_CONTRAST = ['.bg-destructive']

test.describe('Tournaments · the "New tournament" dialog', () => {
  test('refuses an over-long name in the form — no request, no lost work', async ({
    page,
  }) => {
    const { pom, store } = await TournamentsListPage.navigateTo(page)

    await pom.openWithName(TOO_LONG)
    await pom.createButton.click()

    await expect(pom.fieldError(SAY.nameTooLong)).toBeVisible()
    await expect(pom.nameInput).toHaveAttribute('aria-invalid', 'true')

    // Nothing was sent — not a request whose answer was ignored, none at all.
    await expect(pom.dialog).toBeVisible()
    expect(store.countOf('POST')).toBe(0)

    // And the empty name, the other constraint the form mirrors.
    await pom.nameInput.fill('')
    await pom.createButton.click()
    await expect(pom.fieldError(SAY.nameRequired)).toBeVisible()
    expect(store.countOf('POST')).toBe(0)
  })

  test('answers a server 422 in the CLIENT’s words, and keeps the entry', async ({
    page,
  }) => {
    // The residual case: a rule the client did not know to mirror. Forced, because the
    // form now prevents every refusal we DO know about — which is exactly why the
    // unknown one still has to be survivable.
    const { pom, store } = await TournamentsListPage.navigateTo(page)
    store.refuseTournamentCreate()

    await pom.openWithName('Spring Open 2026')
    await pom.postalInput.fill('94703')
    await pom.createButton.click()

    // Told — under the box the server blamed, in the words the form puts above it.
    await expect(pom.fieldError(SAY.refusedName)).toBeVisible()
    await expect(pom.nameInput).toHaveAttribute('aria-invalid', 'true')

    // ⚠️ THE assertion: Pydantic's sentence is nowhere in the document. Not in the
    // hint, not in a banner, not in a toast.
    await expect(page.getByText(PYDANTIC)).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('String should have')

    // The request really did go, and the dialog really did stay — holding everything
    // that was typed into it.
    expect(store.countOf('POST')).toBe(1)
    await expect(pom.dialog).toBeVisible()
    await expect(pom.nameInput).toHaveValue('Spring Open 2026')
    await expect(pom.postalInput).toHaveValue('94703')

    await expectAxeClean(page, 'new tournament — refused by the server', {
      exclude: KNOWN_DESTRUCTIVE_BUTTON_CONTRAST,
    })
  })

  test('creates a tournament and closes on success', async ({ page }) => {
    // The happy path, so the spec above is a claim about a *refusal* and not about a
    // dialog that never worked.
    const { pom, store } = await TournamentsListPage.navigateTo(page)

    await pom.openWithName('Autumn Classic')
    await pom.createButton.click()

    await expect(pom.dialog).toBeHidden()
    expect(store.countOf('POST')).toBe(1)
    // The dialog's success navigation lands on the created tournament.
    await expect(page).toHaveURL(/\/tournaments\/[^/]+$/)
  })
})
