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
    // The `__unresolvable__` sentinel drives the mock's coded 409
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

  it('hints instead of geocoding — and fires NO request — when every venue field is blank', async () => {
    // Count every `GET /v1/geocode`. The assertion that matters is that this
    // number stays at 0: the endpoint requires a non-empty `address`, so an
    // empty form used to flash "Locating…", take a 422, and revert to the
    // button with nothing said. The fix must stop *sending*, not re-label.
    let geocodeCalls = 0
    server.use(
      http.get('*/v1/geocode', () => {
        geocodeCalls += 1
        return new HttpResponse(null, { status: 500 })
      }),
    )
    previewLocationPage.render({
      address: { venue: '', street: '', city: '', region: '', postal: '' },
    })

    await userEvent.click(previewLocationPage.getPreviewButton())

    expect(await previewLocationPage.findHint()).toBeVisible()
    expect(previewLocationPage.queryHint()).toHaveTextContent(
      'Add a venue address to preview its location.',
    )
    expect(geocodeCalls).toBe(0)
    // A blank venue is a valid tournament, not a failure: no pin, and NOT the
    // destructive "we couldn't locate that address" alert (nor a toast).
    expect(previewLocationPage.queryPin()).toBeNull()
    expect(previewLocationPage.queryError()).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
    // No round trip means no "Locating…" to sit through — the button never
    // leaves its resting state.
    expect(previewLocationPage.getPreviewButton()).toBeEnabled()
    expect(previewLocationPage.getPreviewButton()).toHaveTextContent(
      'Preview location',
    )
  })

  it('whitespace-only venue fields are blank too — hint, no request', async () => {
    // `composeAddress` trims and drops blanks, so "   " composes to "" just as
    // "" does. Same short-circuit, same hint.
    let geocodeCalls = 0
    server.use(
      http.get('*/v1/geocode', () => {
        geocodeCalls += 1
        return new HttpResponse(null, { status: 500 })
      }),
    )
    previewLocationPage.render({
      address: {
        venue: '  ',
        street: '',
        city: '\t',
        region: '',
        postal: ' ',
        country: '  ',
      },
    })

    await userEvent.click(previewLocationPage.getPreviewButton())

    expect(await previewLocationPage.findHint()).toBeVisible()
    expect(geocodeCalls).toBe(0)
    expect(previewLocationPage.queryError()).toBeNull()
  })

  it('keeps the neutral hint and the destructive alert distinct', async () => {
    // The unresolvable address gets the red alert and NOT the hint — the two
    // messages are independently addressable, so a later edit can't collapse
    // "nothing typed yet" into "we looked and found nothing".
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
    expect(previewLocationPage.queryHint()).toBeNull()
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
