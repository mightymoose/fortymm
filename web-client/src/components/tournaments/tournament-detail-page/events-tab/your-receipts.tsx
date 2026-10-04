import { useMyTournamentPayments } from '@/components/payments/receipt'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/**
 * A link to the receipt of each payment the player completed in this tournament
 * (#1810). It is how a payer who closed the tab before success finds their
 * receipt. It renders nothing while loading, on a failed read, and when the
 * player has paid for nothing here.
 */
export function YourReceipts({
  tournamentId,
  onViewReceipt,
}: {
  tournamentId: string
  /** Open the receipt inside the app. Without it, the link is an ordinary one. */
  onViewReceipt?: (paymentId: string, options?: { replace?: boolean }) => void
}) {
  const payments = useMyTournamentPayments(tournamentId)
  if (!payments.data || payments.data.length === 0) return null
  return (
    <section aria-labelledby="your-receipts-title" className="mb-5">
      <h3 id="your-receipts-title" className="text-sm font-semibold">
        Your receipts
      </h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {payments.data.map((payment) => (
          <li key={payment.id}>
            <a
              className="text-sm underline underline-offset-4"
              href={`/payments/${payment.id}/receipt`}
              onClick={(event) => {
                // Only a plain primary click navigates in the app. Ctrl, Cmd,
                // Shift, Alt and the middle button keep the browser's own link
                // behavior (a new tab or window).
                if (
                  !onViewReceipt ||
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return
                }
                event.preventDefault()
                onViewReceipt(payment.id)
              }}
            >
              {payment.eventNames.join(', ')} · {usd.format(payment.totalCents / 100)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
