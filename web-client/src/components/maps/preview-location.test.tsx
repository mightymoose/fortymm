import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/mocks/server'
import { waitFor } from '@/test/utilities'

import { previewLocationPage } from './preview-location.page'

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } }
})

beforeEach(() => vi.mocked(toast.error).mockClear())

describe('PreviewLocation', () => {
  it('geocodes the typed address and drops a confirmation pin', async () => {
    previewLocationPage.render()

    expect(previewLocationPage.queryPin()).toBeNull()
    await userEvent.click(previewLocationPage.getPreviewButton())

    // Keyless (dev/CI), `LocationMap` renders its text fallback of the returned
    // `formatted` label — the pin is present, at the geocoded location.
    await waitFor(() => expect(previewLocationPage.queryPin()).not.toBeNull())
    // The pin's fallback echoes the geocoder's `formatted` (the composed address
    // in the mock), and there is no inline error.
    expect(previewLocationPage.queryPin()).toHaveTextContent('Berkeley TT Club')
    expect(previewLocationPage.queryError()).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('surfaces the inline error and NO pin for an unresolvable address', async () => {
    // The `__unresolvable__` sentinel drives the mock's coded 422
    // (`address_not_geocodable`) — the same refusal the write path answers with.
    previewLocationPage.render({
      address: {
        venue: '__unresolvable__',
        street: '',
        city: '',
        region: '',
        postal: '',
      },
    })

    await userEvent.click(previewLocationPage.getPreviewButton())

    expect(await previewLocationPage.findError()).toBeVisible()
    expect(previewLocationPage.queryPin()).toBeNull()
    // An unresolvable address is a fact about the address, not an error to toast.
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('resolves its pending state — never a permanent spinner', async () => {
    previewLocationPage.render()

    await userEvent.click(previewLocationPage.getPreviewButton())

    // Once the lookup settles the button is enabled again and back to its resting
    // label — the "Locating…" state does not latch.
    await waitFor(() =>
      expect(previewLocationPage.getPreviewButton()).toBeEnabled(),
    )
    expect(previewLocationPage.getPreviewButton()).toHaveTextContent(
      'Preview location',
    )
  })

  it('toasts a non-geocode failure instead of the inline "couldn’t locate" note', async () => {
    // A 500 is not "your address is unlocatable" — it must not accuse a good
    // address. It toasts, and the inline note stays absent.
    server.use(
      http.get('*/v1/geocode', () => new HttpResponse(null, { status: 500 })),
    )
    previewLocationPage.render()

    await userEvent.click(previewLocationPage.getPreviewButton())

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(previewLocationPage.queryError()).toBeNull()
    expect(previewLocationPage.queryPin()).toBeNull()
  })
})
