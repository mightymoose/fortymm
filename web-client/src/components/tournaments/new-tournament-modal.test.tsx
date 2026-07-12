import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { screen } from '@/test/utilities'

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

  it('toasts a 5xx in the client’s own words, and keeps the entry', async () => {
    // `ApiError.message` IS the server's `detail` — which is how the raw string used
    // to escape through the toast as well as through the field.
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

    expect(toast.error).toHaveBeenCalledWith("Couldn't create the tournament", {
      description:
        "The server couldn't be reached. Check your connection and try again.",
    })
    expect(newTournamentModalPage.queryDialog()).not.toBeNull()
    expect(newTournamentModalPage.getNameInput()).toHaveValue('Spring Open')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
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

  it('closes via cancel', async () => {
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onOpenChange })

    await userEvent.click(newTournamentModalPage.getCancelButton())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
