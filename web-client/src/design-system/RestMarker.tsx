import { Icon } from './Icon.tsx'

// The rest marker: a clock and "Rest until" the time a player's rest ends, e.g. 12:10. Information,
// not a problem.
export function RestMarker({ until }: { until: string }) {
  return (
    <span className="fm-rest">
      <Icon name="clock" />
      Rest until <span className="num">{until}</span>
    </span>
  )
}
