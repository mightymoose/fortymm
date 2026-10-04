import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import {
  buildPaymentReceipt,
  paymentLines,
} from '@/mocks/factories/checkouts/checkout.factory'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'

import { PaymentReceiptPage } from './payment-receipt-page'

const renderReceipt = (paymentId: string) =>
  renderWithRoutes(<PaymentReceiptPage paymentId={paymentId} />, {
    path: '/payments/$paymentId/receipt',
    initialEntry: `/payments/${paymentId}/receipt`,
  })

describe('PaymentReceiptPage', () => {
  it('itemizes the prices, the total, each event outcome and the support reference', async () => {
    const receipt = buildPaymentReceipt({
      lines: [
        { ...paymentLines('admitted')[0] },
        { ...paymentLines('refund_pending')[1] },
      ],
    })
    server.use(
      http.get(`*/v1/payments/${receipt.id}/receipt`, () => HttpResponse.json(receipt)),
    )

    renderReceipt(receipt.id)

    expect(await screen.findByRole('heading', { level: 1, name: 'Receipt' })).toBeInTheDocument()
    const rows = within(screen.getByRole('list', { name: 'Events' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Open Singles$45.00Entry confirmed',
      'U1500$30.00Not admitted — refund pending',
    ])
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('$75.00')).toBeInTheDocument()
    expect(screen.getByText(`Support reference ${receipt.reference}`)).toBeInTheDocument()
  })

  it('lets the payer remove the stored email, and then shows none', async () => {
    const receipt = buildPaymentReceipt({ receipt_address: 'receipts@example.com' })
    let stored: string | null = receipt.receipt_address ?? null
    const erased: string[] = []
    server.use(
      http.get(`*/v1/payments/${receipt.id}/receipt`, () =>
        HttpResponse.json({ ...receipt, receipt_address: stored }),
      ),
      http.delete(`*/v1/payments/${receipt.id}/receipt-address`, () => {
        erased.push(receipt.id)
        stored = null
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()

    renderReceipt(receipt.id)

    expect(await screen.findByText('receipts@example.com')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove my email' }))

    await waitFor(() => expect(screen.queryByText('receipts@example.com')).not.toBeInTheDocument())
    expect(erased).toEqual([receipt.id])
    expect(screen.queryByRole('button', { name: 'Remove my email' })).not.toBeInTheDocument()
  })

  it('offers no email action when the receipt holds no address', async () => {
    const receipt = buildPaymentReceipt({ receipt_address: null })
    server.use(
      http.get(`*/v1/payments/${receipt.id}/receipt`, () => HttpResponse.json(receipt)),
    )

    renderReceipt(receipt.id)

    await screen.findByRole('heading', { level: 1, name: 'Receipt' })
    expect(screen.queryByRole('button', { name: 'Remove my email' })).not.toBeInTheDocument()
  })

  it('keeps the address and says so when removing it fails', async () => {
    const receipt = buildPaymentReceipt({ receipt_address: 'receipts@example.com' })
    server.use(
      http.get(`*/v1/payments/${receipt.id}/receipt`, () => HttpResponse.json(receipt)),
      http.delete(`*/v1/payments/${receipt.id}/receipt-address`, () =>
        HttpResponse.json({ detail: 'down' }, { status: 503 }),
      ),
    )
    const user = userEvent.setup()

    renderReceipt(receipt.id)
    await user.click(await screen.findByRole('button', { name: 'Remove my email' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t remove your email')
    expect(screen.getByText('receipts@example.com')).toBeInTheDocument()
  })
})
