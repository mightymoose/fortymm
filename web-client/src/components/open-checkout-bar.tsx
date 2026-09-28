import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from '@tanstack/react-router'
import { Clock3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { openCheckoutsQueryOptions, type OpenCheckout } from '@/api/checkouts'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** Whole seconds until `expiresAt`, never below zero. */
function secondsLeft(expiresAt: string, now: number) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000))
}

function mmss(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** A payment under check has no deadline the player can act on: it stays
 * open past the hold's end until the server resolves it. */
const isChecking = (checkout: OpenCheckout) => checkout.paymentState === 'checking'

/** Holds the player can still lose come first, nearest deadline first. Payments
 * under check follow: nothing the player does changes them. */
function byUrgency(checkouts: OpenCheckout[]) {
  return [...checkouts].sort(
    (a, b) =>
      Number(isChecking(a)) - Number(isChecking(b)) ||
      Date.parse(a.expiresAt) - Date.parse(b.expiresAt),
  )
}

/** The tournament whose Events tab is on screen, if any. Its checkout panel
 * already shows its own checkout, so the bar leaves that one out. The Events tab
 * is the page's default, so a URL naming no tab counts. */
function useTournamentOnItsEventsTab(): string | null {
  const { pathname, search } = useLocation()
  const match = /^\/tournaments\/([0-9a-f-]{36})\/?$/i.exec(pathname)
  if (!match) return null
  const tab = (search as { tab?: unknown }).tab
  return tab === undefined || tab === 'events' ? match[1] : null
}

function TournamentLink({
  checkout,
  children,
}: {
  checkout: OpenCheckout
  children: React.ReactNode
}) {
  return (
    <Link
      to="/tournaments/$tournamentId"
      params={{ tournamentId: checkout.tournamentId }}
      // The checkout id rides along: once a hold passes its deadline the
      // Events tab no longer finds it as "current", and a payment still being
      // checked must stay reachable.
      search={{ tab: 'events', checkout: checkout.checkoutId }}
      className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline"
    >
      {children}
    </Link>
  )
}

/**
 * The app-wide open-checkout bar (#1809): under the top header on every
 * signed-in page, so a hold never expires unnoticed. It sits in the page flow,
 * never over content.
 *
 * It does not poll. A `checkout.changed` hint refetches it (the realtime
 * invalidation table), and so does a hold's countdown reaching zero. The
 * countdown is not a live region: a screen reader hears the bar's state
 * change, never a tick every second.
 */
export function OpenCheckoutBar() {
  const { data, refetch } = useQuery(openCheckoutsQueryOptions())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  // A hold that reaches zero has ended on the server, or is about to: refetch
  // once for that deadline. Once, because a server that still lists it (a
  // payment moved to checking at the last second) must not loop the fetch.
  const refetchedDeadlines = useRef(new Set<string>())
  const lapsed = (data ?? []).filter(
    (checkout) => !isChecking(checkout) && secondsLeft(checkout.expiresAt, now) === 0,
  )
  const lapsedKey = lapsed
    .map((checkout) => `${checkout.checkoutId}@${checkout.expiresAt}`)
    .join(',')
  useEffect(() => {
    const fresh = lapsedKey
      .split(',')
      .filter((key) => key && !refetchedDeadlines.current.has(key))
    if (fresh.length === 0) return
    for (const key of fresh) refetchedDeadlines.current.add(key)
    void refetch()
  }, [lapsedKey, refetch])

  const onEventsTabOf = useTournamentOnItsEventsTab()
  const open = byUrgency(
    (data ?? []).filter((checkout) => checkout.tournamentId !== onEventsTabOf),
  )
  const nearest = open[0]
  if (!nearest) return null
  const others = open.length - 1

  return (
    <section
      aria-label="Open checkouts"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-primary/25 bg-primary/5 px-4 py-2 text-sm"
    >
      <Clock3 size={15} aria-hidden className="shrink-0 text-primary" />
      <span data-testid="open-checkout-summary" className="min-w-0 break-words">
        {isChecking(nearest)
          ? `Checking your payment · ${nearest.tournamentName}`
          : `Checkout open · ${nearest.tournamentName} · ${mmss(secondsLeft(nearest.expiresAt, now))} left`}
      </span>
      <TournamentLink checkout={nearest}>
        {isChecking(nearest) ? 'View' : 'Resume'}
      </TournamentLink>
      {others > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm">
              +{others} more
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <ul aria-label="All open checkouts" className="flex flex-col gap-2">
              {open.map((checkout) => (
                <li key={checkout.checkoutId} className="flex flex-col">
                  <TournamentLink checkout={checkout}>
                    {checkout.tournamentName}
                  </TournamentLink>
                  <span className="text-xs text-muted-foreground">
                    {isChecking(checkout)
                      ? 'Checking your payment'
                      : `${mmss(secondsLeft(checkout.expiresAt, now))} left`}
                  </span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </section>
  )
}
