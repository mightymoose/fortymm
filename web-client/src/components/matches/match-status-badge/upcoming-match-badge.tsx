import { Badge } from '@/components/ui/badge'

export function UpcomingMatchBadge() {
  return (
    <Badge
      variant="outline"
      className="border-[color:var(--warn)] bg-[rgba(255,196,61,0.1)] text-[color:var(--warn)]"
    >
      <span className="size-2.5 rounded-full bg-current" aria-hidden />
      Upcoming
    </Badge>
  )
}
