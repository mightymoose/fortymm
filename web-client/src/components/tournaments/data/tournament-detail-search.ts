import { z } from 'zod'

import { eventEditorSearchSchema } from './event-editor-search'

/** The tournament page's tabs, in the order the page shows them. */
export const TOURNAMENT_TABS = ['events', 'tables', 'schedule', 'details'] as const
export type TournamentTab = (typeof TOURNAMENT_TABS)[number]

const tabSchema = z.object({ tab: z.enum(TOURNAMENT_TABS) }).partial().catch({})

/** `?checkout=` names the checkout the Events tab's panel shows (#1809). It is
 * Stripe's `return_url` target, and it keeps a payment's result on screen
 * across a reload. */
const checkoutSchema = z.object({ checkout: z.string().uuid() }).partial().catch({})

/**
 * The tournament route's whole search, parsed at the boundary
 * (`.claude/rules/parse-at-boundaries.md`). Each param parses on its own, so a
 * malformed one drops only itself: `?checkout=garbage` must not close an open
 * editor, and a garbage `?event=` must not lose a payment's result.
 */
export const tournamentDetailSearchSchema = z
  .object({
    event: z.unknown(),
    tab: z.unknown(),
    checkout: z.unknown(),
  })
  .partial()
  .transform((raw) => ({
    ...eventEditorSearchSchema.parse({ event: raw.event }),
    ...tabSchema.parse({ tab: raw.tab }),
    ...checkoutSchema.parse({ checkout: raw.checkout }),
  }))

export type TournamentDetailSearch = z.output<typeof tournamentDetailSearchSchema>

/** The query params Stripe appends to a `return_url` after a redirect (3-D
 * Secure). One of them is the PaymentIntent's client secret, so the page drops
 * them all on arrival (#1809). */
export const STRIPE_RETURN_PARAMS = [
  'payment_intent',
  'payment_intent_client_secret',
  'redirect_status',
] as const
