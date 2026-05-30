import { Skeleton } from '@/components/ui/skeleton'

// Loading placeholder for one <Line /> row: an avatar + name in the player
// column, then one skeleton per game cell. Emits the same grid children as
// <Line /> so it slots into the md-games grid identically.
export const LineSkeleton = ({ bestOf }: { bestOf: number }) => (
  <>
    <div className="md-games__player">
      <Skeleton className="md-avatar" />
      <Skeleton className="h-4 w-24" />
    </div>
    {Array.from({ length: bestOf }, (_, i) => (
      <div key={i} className="md-games__cell">
        {/* h-[22px] matches the 22px line height of a real score so the cell —
            and therefore the row — keeps the same height as the loaded state. */}
        <Skeleton className="h-[22px] w-5" />
      </div>
    ))}
  </>
)
