import { createFileRoute } from '@tanstack/react-router'

import { pageTitle } from '@/lib/page-title'

/** The public statement of the entry-fee refund policy (#1760). It sits outside
 * the `_app` layout, so a signed-out reader never mints a guest session. The
 * checkout panel's "Refund terms" link points here. */
export const Route = createFileRoute('/refund-terms')({
  head: () => ({
    meta: [{ title: pageTitle('Refund terms') }],
  }),
  component: RefundTermsPage,
})

const POLICY = [
  'Refunds are full refunds only, per event.',
  'If you withdraw before registration closes, your refund is automatic. After registration closes, the organizer approves the refund.',
  'If an event is cancelled, every paid entry in it is refunded.',
  'You never pay card fees.',
  'A combined payment is refunded one event at a time.',
]

function RefundTermsPage() {
  return (
    <main className="mx-auto max-w-[680px] px-4 py-12 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">Refund terms</h1>
      <p className="mt-3 text-muted-foreground">
        These terms cover entry fees you pay for tournament events on FortyMM.
      </p>
      <ul className="mt-6 list-disc space-y-3 pl-5">
        {POLICY.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </main>
  )
}
