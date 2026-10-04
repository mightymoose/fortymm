import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { z } from 'zod'

import { NotFoundContent } from '@/components/not-found-content'
import { PaymentReceiptPage } from '@/components/payments/payment-receipt-page'
import { pageTitle } from '@/lib/page-title'

/** The payment id segment. The API types `payment_id` as a `uuid.UUID`, so a
 * non-uuid segment is a URL that names no receipt, never a request to make. */
const paymentIdSchema = z.string().uuid()

export const Route = createFileRoute('/_app/payments/$paymentId/receipt')({
  params: {
    parse: (raw) => {
      const parsed = paymentIdSchema.safeParse(raw.paymentId)
      if (!parsed.success) throw notFound()
      return { paymentId: parsed.data }
    },
  },
  head: () => ({
    meta: [{ title: pageTitle('Receipt') }],
  }),
  component: PaymentReceiptRoute,
  notFoundComponent: ReceiptNotFound,
})

function PaymentReceiptRoute() {
  const { paymentId } = Route.useParams()
  return <PaymentReceiptPage paymentId={paymentId} />
}

function ReceiptNotFound() {
  return (
    <NotFoundContent
      headline="Receipt not found."
      body={<>No receipt with that id. The link may be wrong.</>}
      action={<Link to="/dashboard">Back to dashboard</Link>}
    />
  )
}
