import { Badge } from '@/components/ui/badge'

export function FinalMatchBadge() {
  return (
    <Badge
      variant="outline"
      className="border-[color:var(--ball-500)] bg-[rgba(255,122,26,0.1)] text-[color:var(--ball-500)]"
    >
      <span className="size-2.5 rounded-full bg-current" aria-hidden />
      Final
    </Badge>
  )
}
