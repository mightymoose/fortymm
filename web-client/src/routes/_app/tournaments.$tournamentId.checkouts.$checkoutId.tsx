import { createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'

import { CheckoutPage } from '@/components/tournaments/checkout-page'
import { pageTitle } from '@/lib/page-title'

const id = z.string().uuid()

export const Route = createFileRoute(
  '/_app/tournaments/$tournamentId/checkouts/$checkoutId',
)({
  params: {
    parse: (raw) => {
      const checkoutId = id.safeParse(raw.checkoutId)
      if (!checkoutId.success) throw notFound()
      return { checkoutId: checkoutId.data }
    },
  },
  head: () => ({ meta: [{ title: pageTitle('Checkout') }] }),
  component: CheckoutRoute,
})

function CheckoutRoute() {
  const { tournamentId, checkoutId } = Route.useParams()
  return <CheckoutPage tournamentId={tournamentId} checkoutId={checkoutId} />
}
