import { Skeleton } from '@/components/ui/skeleton'

// Loading placeholder for <MatchStatusBadge />: a pill the size of a status
// chip. Matches the real `Badge` height (h-5) and approximate width so the meta
// strip reserves the same space — a taller or wider placeholder shifts the row
// below (and, on narrow viewports, wraps the strip onto a second line).
export function MatchStatusBadgeSkeleton() {
  return <Skeleton className="h-5 w-16 rounded-full" />
}
