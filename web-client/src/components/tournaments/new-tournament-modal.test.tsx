import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { UNBREAKABLE_VENUE_NAME } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { fireEvent, screen, waitFor } from '@/test/utilities'

import { newTournamentModalPage } from './new-tournament-modal.page'

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } }
})

beforeEach(() => vi.mocked(toast.error).mockClear())

/**
 * ⚠️ The string that must NEVER be on screen. It is what FastAPI really answers a
 * 256-character `TournamentCreate.name` with — Pydantic's own prose, in the wire's
 * vocabulary — and it is what this dialog used to pipe straight onto its name field
 * (`form.setError('name', { message: err.detail })`).
 * `DEFINITION_OF_COMPLETE.md`: *"Raw API detail strings never reach the UI."*
 */
const PYDANTIC = 'String should have at most 255 characters'

/** FastAPI's real 422 body for it: a `detail` ARRAY of `{loc, msg}`. Whatever the
 * server's next unmirrored constraint on a tournament turns out to be, this is the
 * shape it arrives in. */
const refusedName = new ApiError(422, PYDANTIC, 'create tournament', {
  detail: [
    { type: 'string_too_long', loc: ['body', 'name'], msg: PYDANTIC },
  ],
})

describe('NewTournamentModal', () => {
  it('emits the draft with name and address, then closes on success', async () => {
    const onCreate = vi.fn()
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      name: 'Spring Open',
      status: 'draft',
    })
    // The modal owns closing — only after onCreate resolves.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // A tournament may be created with NO VENUE at all (CONTEXT.md, "Venue"):
  // organizers announce before the room is booked, and a tournament at somebody's
  // home withholds its address on purpose. The dialog must submit that, and must
  // submit it as `null` — six empty strings plus a default country is a VENUE, and
  // the server would take it at its word and go and geocode "USA".
  it('sends NO VENUE — null, not six empty strings — when the venue boxes are blank', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Garage Invitational')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0].address).toBeNull()
  })

  it('starts a venue from ANY single box the organizer fills in', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    // Not the venue name — the least likely box, so this cannot pass by looking at
    // one field and calling it the venue.
    await userEvent.type(screen.getByLabelText('Postal'), '94703')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(onCreate.mock.calls[0][0].address).toMatchObject({
      postal: '94703',
      venue: '',
      country: 'USA',
    })
  })

  it('blocks an empty name with an inline error and does not submit', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(
      await newTournamentModalPage.findError('Name is required.'),
    ).toBeVisible()
    expect(newTournamentModalPage.getNameInput()).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('blocks a name longer than 255 characters client-side', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    const input = newTournamentModalPage.getNameInput()
    await userEvent.click(input)
    await userEvent.paste('A'.repeat(256))
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(
      await newTournamentModalPage.findError(
        'Name must be 255 characters or fewer.',
      ),
    ).toBeVisible()
    expect(onCreate).not.toHaveBeenCalled()
  })

  /**
   * The venue box carries the server's `AddressComponent` bound (#1199).
   *
   * It has to be re-stated on the client at all because the generated schema drops
   * it: `openapi-typescript` has no TypeScript construct for a string length, so
   * `maxLength` appears **nowhere** in `src/api/schema.d.ts`. Nothing between the
   * organizer and the API knows about the 255 except this.
   */
  it('caps the venue box at the 255 characters the server accepts', async () => {
    newTournamentModalPage.render()

    const input = newTournamentModalPage.getVenueInput()
    expect(input).toHaveAttribute('maxlength', '255')

    // Pasting the pathological 680-character name in — the realistic way an
    // over-long venue gets typed — leaves 255 in the box, not 680.
    await userEvent.click(input)
    await userEvent.paste(UNBREAKABLE_VENUE_NAME)
    expect((input as HTMLInputElement).value).toHaveLength(255)
  })

  it('refuses an over-long venue inline rather than letting the server 422 it', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    // `fireEvent.change`, deliberately: `maxLength` already stops typing and
    // pasting, so the only way a 680-character venue reaches the form is a
    // programmatic set — autofill, a password manager, a restored draft. The Zod
    // bound is what catches THAT, and this is the only way to exercise it. Without
    // it the organizer's feedback is a nested-address 422 the form cannot even pin
    // to a box (`FORM_FIELD` maps `name` alone), i.e. the banner.
    fireEvent.change(newTournamentModalPage.getVenueInput(), {
      target: { value: UNBREAKABLE_VENUE_NAME },
    })
    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(
      await newTournamentModalPage.findError(
        'Venue name must be 255 characters or fewer.',
      ),
    ).toBeVisible()
    expect(onCreate).not.toHaveBeenCalled()
  })

  /**
   * …and the same for the other four, because the bound is the server's
   * `AddressComponent` and it applies to **all six** components — not to the one box
   * we imagined somebody would paste into.
   *
   * The four used to carry `maxLength` and no Zod bound at all, justified as "none of
   * them is a field someone pastes an essay into". That is a claim about user
   * behaviour holding up a data bound, and `maxLength` is exactly the mechanism it
   * does not cover: it caps typing and pasting, and does nothing about autofill, a
   * password manager, or a restored draft — which is why this sweeps with
   * `fireEvent.change`, the programmatic set those all amount to.
   *
   * Swept as a table so a sixth box cannot be added with only the DOM attribute:
   * each names itself, so the sentence lands under the right one.
   */
  it.each([
    ['Street', 'Street must be 255 characters or fewer.'],
    ['City', 'City must be 255 characters or fewer.'],
    ['Region', 'Region must be 255 characters or fewer.'],
    ['Postal', 'Postal must be 255 characters or fewer.'],
  ])(
    'refuses an over-long %s inline rather than letting the server 422 it',
    async (label, message) => {
      const onCreate = vi.fn()
      newTournamentModalPage.render({ onCreate })

      const input = newTournamentModalPage.getAddressInput(label)
      // The hard stop is still there for typing/pasting…
      expect(input).toHaveAttribute('maxlength', '255')
      // …and the Zod bound catches the value that got in some other way.
      fireEvent.change(input, { target: { value: UNBREAKABLE_VENUE_NAME } })
      await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
      await userEvent.click(newTournamentModalPage.getCreateButton())

      expect(await newTournamentModalPage.findError(message)).toBeVisible()
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(onCreate).not.toHaveBeenCalled()
    },
  )

  /**
   * THE regression (#783 QA, round two). The dialog did
   * `form.setError('name', { message: err.detail })`, so a 422 printed Pydantic's
   * sentence under the box — the same violation the event editor's banner had, in its
   * sibling. Both now go through one classifier and one copy table
   * (`data/save-failure`).
   */
  it('never reads Pydantic’s words back to the organizer', async () => {
    const onCreate = vi.fn().mockRejectedValue(refusedName)
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    // Ours, under the box the server named — and the wire's words nowhere at all.
    expect(
      await newTournamentModalPage.findError(
        'The Name was rejected. Check that field and try again.',
      ),
    ).toBeVisible()
    expect(screen.queryByText(PYDANTIC)).toBeNull()
    expect(screen.queryByText(/String|character/)).toBeNull()

    expect(newTournamentModalPage.getNameInput()).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    // Failure must not close over the user's entry.
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('puts a refusal it cannot pin to one box on the dialog’s own banner', async () => {
    // `loc: ["body", "address", "postal"]` — nested, so there is no single box to
    // redden. The banner names the block of the form instead, in the client's words.
    const onCreate = vi.fn().mockRejectedValue(
      new ApiError(422, 'Input should be a valid string', 'create tournament', {
        detail: [
          {
            loc: ['body', 'address', 'postal'],
            msg: 'Input should be a valid string',
          },
        ],
      }),
    )
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    const banner = await newTournamentModalPage.findErrorBanner()
    expect(banner).toHaveTextContent(
      'The Venue address was rejected. Check that field and try again.',
    )
    expect(banner).not.toHaveTextContent(/Input should be/)
    // The name was not what was refused, so it is not what turns red.
    expect(newTournamentModalPage.getNameInput()).not.toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('speaks the server’s own sentence only for a refusal it cannot name (ADR-0968)', async () => {
    // A 409/403's `detail` is a sentence a human wrote for a human — the sanctioned
    // fallback, and the ONLY server string this dialog will ever render.
    const onCreate = vi.fn().mockRejectedValue(
      new ApiError(403, 'You can only create tournaments as an organizer.', 'x', {
        detail: 'You can only create tournaments as an organizer.',
      }),
    )
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(await newTournamentModalPage.findErrorBanner()).toHaveTextContent(
      'You can only create tournaments as an organizer.',
    )
  })

  /**
   * ⚠️ **THE round-three regression: a 5xx was a SILENT NO-OP.** QA injected a 500 on
   * `POST /v1/tournaments` and got *no inline error, no toast, no alert* — the Create
   * button went back to idle and the app simply did nothing. The 422 path had been
   * fixed; the 5xx path was never wired to the classifier at all, and its only channel
   * was a toast (a portal, elsewhere on the page, gone in four seconds).
   *
   * So the assertion is not "it toasts". It is the contract every failure of this dialog
   * now shares with the 422: **it says something, it stays open, and it keeps the
   * work.**
   */
  it('a 5xx SAYS SOMETHING — it is never a click that did nothing', async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError(500, 'Internal Server Error', 'create tournament', {
          detail: 'Internal Server Error',
        }),
      )
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    // Said — on the banner, beside the work, not in a portal that leaves.
    const banner = await newTournamentModalPage.findErrorBanner()
    expect(banner).toHaveTextContent(
      'Something went wrong on our end. Nothing you did caused it',
    )
    // …and it does NOT send them to go and check their wifi over our fault (BUG 1).
    expect(banner).not.toHaveTextContent(/connection|reached/)
    // …nor read the server's own 500 prose out to them.
    expect(banner).not.toHaveTextContent('Internal Server Error')

    // Open, and still holding every character they typed.
    expect(newTournamentModalPage.queryDialog()).not.toBeNull()
    expect(newTournamentModalPage.getNameInput()).toHaveValue('Spring Open')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('an OUTAGE says the connection failed — the one failure that may say so', async () => {
    // A genuine no-response failure: `fetch` rejects and openapi-fetch re-throws, so it
    // reaches the dialog as a raw `TypeError`, not an `ApiError` (`src/api/client.ts`).
    const onCreate = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(await newTournamentModalPage.findErrorBanner()).toHaveTextContent(
      "The server couldn't be reached. Check your connection and try again.",
    )
    expect(newTournamentModalPage.getNameInput()).toHaveValue('Spring Open')
  })

  it('even a failure it cannot classify at all still says something', async () => {
    // The last hole through which silence could get out: a rejection that is not an
    // `ApiError` and not a fetch failure either — a bug of ours. It is still not allowed
    // to end in a dialog that just sits there.
    const onCreate = vi.fn().mockRejectedValue(new Error('boom'))
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(await newTournamentModalPage.findErrorBanner()).toHaveTextContent(
      'Something went wrong. Try again.',
    )
    expect(newTournamentModalPage.queryDialog()).not.toBeNull()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('raises NO toast for any of it — the banner is the channel (Forms convention)', async () => {
    // A form owns its errors inline; a toast on top would double up, and a toast *on its
    // own* was how the 5xx managed to say nothing at all.
    const onCreate = vi
      .fn()
      .mockRejectedValue(new ApiError(500, null, 'create tournament'))
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(await newTournamentModalPage.findErrorBanner()).toBeVisible()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('clears the banner on the next attempt', async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, 'You already run a tournament by that name.', 'x', {
          detail: 'You already run a tournament by that name.',
        }),
      )
      .mockResolvedValueOnce(undefined)
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())
    expect(await newTournamentModalPage.findErrorBanner()).toBeVisible()

    await userEvent.type(newTournamentModalPage.getNameInput(), ' 2026')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(newTournamentModalPage.queryErrorBanner()).toBeNull()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  /**
   * Keyboard focus on a refused create (#1538) — the dialog's half of the same
   * defect as the event editor's. jsdom cannot prove the visible-focus-indicator
   * or true-Tab-order criteria; the Playwright suite covers those.
   */
  describe('focus moves to the failure banner on a refusal (#1538)', () => {
    it('focuses the banner when the server refuses a create', async () => {
      const onCreate = vi
        .fn()
        .mockRejectedValue(new ApiError(500, null, 'create tournament'))
      newTournamentModalPage.render({ onCreate })

      await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
      await userEvent.click(newTournamentModalPage.getCreateButton())

      await waitFor(() =>
        expect(newTournamentModalPage.queryErrorBanner()).toHaveFocus(),
      )
    })

    it('stays out of the tab order — `tabindex="-1"` — while it holds focus', async () => {
      const onCreate = vi
        .fn()
        .mockRejectedValue(new ApiError(500, null, 'create tournament'))
      newTournamentModalPage.render({ onCreate })

      await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
      await userEvent.click(newTournamentModalPage.getCreateButton())

      await waitFor(() =>
        expect(newTournamentModalPage.queryErrorBanner()).toHaveAttribute(
          'tabindex',
          '-1',
        ),
      )
    })

    it('moves focus to the banner again on a second refused create', async () => {
      // React Hook Form clears `errors.root` when the next submit starts and
      // `submit` re-sets it in the catch, so the banner unmounts and remounts on
      // every refusal (mirrors event-editor's `performSave`) — focus must move
      // again, not just once per open.
      const onCreate = vi
        .fn()
        .mockRejectedValue(new ApiError(500, null, 'create tournament'))
      newTournamentModalPage.render({ onCreate })

      await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
      await userEvent.click(newTournamentModalPage.getCreateButton())
      await waitFor(() =>
        expect(newTournamentModalPage.queryErrorBanner()).toHaveFocus(),
      )

      newTournamentModalPage.getNameInput().focus()
      expect(newTournamentModalPage.queryErrorBanner()).not.toHaveFocus()

      await userEvent.click(newTournamentModalPage.getCreateButton())
      await waitFor(() =>
        expect(newTournamentModalPage.queryErrorBanner()).toHaveFocus(),
      )
    })

    it('does not steal focus back to the banner while the organizer keeps typing after a refusal', async () => {
      // The open question the planning note flagged: `mode: 'onChange'` revalidates
      // the touched field on every keystroke, but the resolver never assigns
      // `errors.root` — so a fresh reference must not arrive mid-sentence and pull
      // focus off the field the organizer is back in.
      const onCreate = vi
        .fn()
        .mockRejectedValue(new ApiError(500, null, 'create tournament'))
      newTournamentModalPage.render({ onCreate })

      await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
      await userEvent.click(newTournamentModalPage.getCreateButton())
      await waitFor(() =>
        expect(newTournamentModalPage.queryErrorBanner()).toHaveFocus(),
      )

      await userEvent.type(newTournamentModalPage.getNameInput(), ' 2026')

      expect(newTournamentModalPage.getNameInput()).toHaveFocus()
    })

    it('moves no focus on a fresh open with no failure', () => {
      newTournamentModalPage.render({})

      expect(newTournamentModalPage.queryErrorBanner()).toBeNull()
    })
  })

  it('closes via cancel', async () => {
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onOpenChange })

    await userEvent.click(newTournamentModalPage.getCancelButton())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // ----- Preview location (chore 4e) -------------------------------------

  it('previews the typed venue address and drops a pin — without saving', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(
      screen.getByLabelText('Venue name'),
      'Berkeley TT Club',
    )
    await userEvent.click(newTournamentModalPage.getPreviewButton())

    // The geocode resolves and the pin renders (keyless text fallback), and the
    // preview did NOT fire a save.
    await waitFor(() =>
      expect(newTournamentModalPage.queryPreviewPin()).not.toBeNull(),
    )
    expect(newTournamentModalPage.queryPreviewError()).toBeNull()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('hints, and fires no geocode, when Preview is clicked with the venue blank', async () => {
    // The write surface renders the shared affordance, so the empty-form
    // short-circuit has to hold here too: no request, a neutral hint, and none
    // of the destructive "we couldn't locate that address" alert.
    let geocodeCalls = 0
    server.use(
      http.get('*/v1/geocode', () => {
        geocodeCalls += 1
        return new HttpResponse(null, { status: 500 })
      }),
    )
    newTournamentModalPage.render()

    await userEvent.click(newTournamentModalPage.getPreviewButton())

    expect(await newTournamentModalPage.findPreviewHint()).toBeVisible()
    expect(geocodeCalls).toBe(0)
    expect(newTournamentModalPage.queryPreviewPin()).toBeNull()
    expect(newTournamentModalPage.queryPreviewError()).toBeNull()
  })

  it('surfaces an inline error and no pin for an unresolvable address', async () => {
    newTournamentModalPage.render()

    // The `__unresolvable__` sentinel drives the mock's coded 409 — the same
    // refusal the write path answers a zero-result address with.
    await userEvent.type(
      screen.getByLabelText('Venue name'),
      '__unresolvable__',
    )
    await userEvent.click(newTournamentModalPage.getPreviewButton())

    expect(await newTournamentModalPage.findPreviewError()).toBeVisible()
    expect(newTournamentModalPage.queryPreviewPin()).toBeNull()
  })

  it('a preview then a submit sends only the address fields — no geocoded coords leak in', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.type(
      screen.getByLabelText('Venue name'),
      'Berkeley TT Club',
    )
    // Preview first (the geocode returns lat/lng), then save.
    await userEvent.click(newTournamentModalPage.getPreviewButton())
    await waitFor(() =>
      expect(newTournamentModalPage.queryPreviewPin()).not.toBeNull(),
    )
    await userEvent.click(newTournamentModalPage.getCreateButton())

    // The submitted address is exactly what was typed; the geocoded coordinates
    // never leaked into it — the placeholder 0/0 the read-model draft carries is
    // untouched, and `draftToCreateBody` drops even those on the wire.
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0].address).toEqual({
      venue: 'Berkeley TT Club',
      street: '',
      city: '',
      region: '',
      postal: '',
      country: 'USA',
      latitude: 0,
      longitude: 0,
    })
  })
})
