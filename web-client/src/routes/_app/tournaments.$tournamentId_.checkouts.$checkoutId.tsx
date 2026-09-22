import { createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'

import { CheckoutPage } from '@/components/tournaments/checkout-page'
import { pageTitle } from '@/lib/page-title'

const id = z.string().uuid()

export const Route = createFileRoute(
  '/_app/tournaments/$tournamentId_/checkouts/$checkoutId',
)({
  params: {
    parse: (raw) => {
      const tournamentId = id.safeParse(raw.tournamentId)
      const checkoutId = id.safeParse(raw.checkoutId)
      if (!tournamentId.success || !checkoutId.success) throw notFound()
      return {
        tournamentId: tournamentId.data,
        checkoutId: checkoutId.data,
      }
    },
  },
  head: () => ({ meta: [{ title: pageTitle('Checkout') }] }),
  component: CheckoutRoute,
})

function CheckoutRoute() {
  const { tournamentId, checkoutId } = Route.useParams()
  return <CheckoutPage tournamentId={tournamentId} checkoutId={checkoutId} />
}
