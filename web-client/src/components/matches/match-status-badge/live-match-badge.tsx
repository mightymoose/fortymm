import { Badge } from '@/components/ui/badge'

export function LiveMatchBadge({ gameNumber }: { gameNumber: number }) {
  return (
    <Badge
      variant="outline"
      className="border-[color:var(--serve-500)] bg-[color:var(--bg-live-soft)] text-[color:var(--serve-500)]"
    >
      <span className="ball-dot ball-dot--live" aria-hidden />
      Live · Game {gameNumber}
    </Badge>
  )
}
