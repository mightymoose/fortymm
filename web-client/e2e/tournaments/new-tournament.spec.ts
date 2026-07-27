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
import { UNRESOLVABLE_ADDRESS } from '../page-objects/tournaments/tournaments-store'
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

  /**
   * ⚠️ **THE round-three bug: the 500 was a SILENT NO-OP.** QA injected a 500 on
   * `POST /v1/tournaments` and the app said *nothing* — no inline error, no toast, no
   * alert. The Create button returned to idle and no tournament appeared. The 5xx branch
   * was never wired to the classifier the 422 had been given; its only channel was a
   * toast, and a toast that does not fire is a click that did nothing.
   *
   * Only a browser can prove the absence: a component test asserts what one locator says,
   * while this asserts what the *whole document* now says and what no portal is hiding.
   */
  test('a 500 SAYS SOMETHING — it is never a click that silently does nothing', async ({
    page,
  }) => {
    const { pom, store } = await TournamentsListPage.navigateTo(page)
    store.faultTournamentCreate()

    await pom.openWithName('Spring Open 2026')
    await pom.postalInput.fill('94703')
    await pom.createButton.click()

    // The request really did go and really did 500 — this is not the form guarding.
    await expect(pom.errorBanner).toBeVisible()
    expect(store.countOf('POST')).toBe(1)

    // Said, in our words — and NOT in the words the old arm used, which blamed a
    // connection that is plainly working: the server answered this request (BUG 1).
    await expect(pom.errorBanner).toContainText('Something went wrong on our end')
    await expect(pom.errorBanner).not.toContainText(/connection|couldn't be reached/)
    // …nor is FastAPI's own 500 prose on screen anywhere.
    await expect(page.getByText('Internal Server Error')).toHaveCount(0)

    // Open, and holding everything that was typed into it — the same contract the 422
    // has, because a 5xx destroys a draft just as thoroughly as a 422 does.
    await expect(pom.dialog).toBeVisible()
    await expect(pom.nameInput).toHaveValue('Spring Open 2026')
    await expect(pom.postalInput).toHaveValue('94703')
    await expect(page).toHaveURL(/\/tournaments\/?$/)

    // New red markup, in a portalled dialog, whose contrast jsdom cannot see.
    await expectAxeClean(page, 'new tournament — the server faulted', {
      exclude: KNOWN_DESTRUCTIVE_BUTTON_CONTRAST,
    })
  })

  test('a network OUTAGE is the one failure that may blame the connection', async ({
    page,
  }) => {
    // The other designed state. `route.abort()` is a real no-response failure: `fetch`
    // rejects, openapi-fetch re-throws, and the dialog meets a raw `TypeError` — which is
    // exactly what an offline phone produces, and exactly what the 500 is NOT.
    const { pom } = await TournamentsListPage.navigateTo(page)
    await page.route('**/api/v1/tournaments', (route) =>
      route.request().method() === 'POST' ? route.abort('failed') : route.fallback(),
    )

    await pom.openWithName('Spring Open 2026')
    await pom.createButton.click()

    await expect(pom.errorBanner).toContainText(
      "The server couldn't be reached. Check your connection and try again.",
    )
    await expect(pom.dialog).toBeVisible()
    await expect(pom.nameInput).toHaveValue('Spring Open 2026')
  })

  /**
   * "Preview location" with the venue boxes empty used to flash "Locating…", take
   * a **422** off the endpoint's own `min_length` on `address`, and then revert to
   * the button saying nothing at all.
   *
   * Only a browser can prove the half that matters: that **no request leaves**. A
   * component test can be satisfied by a re-labelled error; the store here tallies
   * every call the app really makes through the real fetch stack, with MSW off.
   * The second half of the test then geocodes for real, so the tally is a live
   * observation and not a counter that never moves.
   */
  test('previewing an empty venue hints — with no request, and never the red alert', async ({
    page,
  }) => {
    const { pom, store } = await TournamentsListPage.navigateTo(page)
    const geocodes = () =>
      store.requests.filter((r) => r.path === '/v1/geocode').length

    await pom.openWithName('Spring Open 2026')
    await pom.previewLocationButton.click()

    // Answered locally and at once: the neutral hint, no pin, and NOT the
    // destructive "we couldn't locate that address" alert — a tournament with no
    // venue is valid, so nothing here failed.
    await expect(pom.previewLocationHint).toBeVisible()
    await expect(pom.previewLocationHint).toContainText(
      'Add a venue address to preview its location.',
    )
    await expect(pom.previewLocationError).toHaveCount(0)
    await expect(page.getByTestId('location-map-fallback')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('Locating…')
    // ⚠️ THE assertion: nothing was sent.
    expect(geocodes()).toBe(0)

    // New markup in a portalled dialog, whose contrast jsdom cannot see — and a
    // muted "low-key" hint is exactly the kind that fails AA if hand-tinted.
    await expectAxeClean(page, 'new tournament — the empty-venue preview hint', {
      exclude: KNOWN_DESTRUCTIVE_BUTTON_CONTRAST,
    })

    // Now the genuine zero-results address: the request DOES go, and the red alert
    // — not the hint — is what answers it.
    await pom.venueInput.fill(UNRESOLVABLE_ADDRESS)
    await pom.previewLocationButton.click()

    await expect(pom.previewLocationError).toBeVisible()
    await expect(pom.previewLocationHint).toHaveCount(0)
    expect(geocodes()).toBe(1)

    // Neither preview saved anything, and nothing fell through the stub.
    expect(store.countOf('POST')).toBe(0)
    expect(store.unhandled).toEqual([])
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

  /**
   * A tournament may be created with **no venue at all** (CONTEXT.md, "Venue"):
   * announced before the room is booked, or held at somebody's home whose address
   * is deliberately withheld. The dialog above leaves every venue box empty, and
   * this is the assertion about what that PUT ON THE WIRE.
   *
   * It belongs here rather than in vitest because the claim is about the serialized
   * request body, after the real `openapi-fetch` client with MSW off. A component
   * test can only see the draft handed to the callback; `address: null` versus six
   * empty strings plus a defaulted `country: "USA"` is a difference the server acts
   * on — the latter is a venue, and it would get geocoded.
   */
  test('sends address: null when the venue boxes are left empty', async ({
    page,
  }) => {
    const { pom, store } = await TournamentsListPage.navigateTo(page)

    await pom.openWithName('Garage Invitational')
    await pom.createButton.click()

    await expect(pom.dialog).toBeHidden()
    expect(store.createBodies).toHaveLength(1)
    expect(store.createBodies[0].address).toBeNull()
    expect(store.unhandled).toEqual([])
  })

  /** The positive control for the test above: a typed venue really is sent, so the
   * `null` there is about the empty boxes and not about a dialog that stopped
   * sending an address at all. */
  test('sends the venue the organizer typed', async ({ page }) => {
    const { pom, store } = await TournamentsListPage.navigateTo(page)

    await pom.openWithName('Autumn Classic')
    await pom.venueInput.fill('Berkeley TT Club')
    await pom.createButton.click()

    await expect(pom.dialog).toBeHidden()
    expect(store.createBodies[0].address).toMatchObject({
      venue: 'Berkeley TT Club',
      country: 'USA',
    })
  })
})
