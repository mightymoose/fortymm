import { Badge } from '@/components/ui/badge'

export function AwaitingConfirmationBadge() {
  return (
    <Badge variant="secondary">
      <span className="size-2.5 rounded-full bg-current" aria-hidden />
      Awaiting confirmation
    </Badge>
  )
}
