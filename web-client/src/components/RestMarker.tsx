import { Icon } from './Icon.tsx'
import './RestMarker.css'

// The design system's rest marker (.fm-rest): a player resting until a time
// ("Rest until 19:35"), with a clock, in --rest. `until` is the time as it
// is shown, in figures.
export function RestMarker({ until }: { until: string }) {
  return (
    <span className="rest-marker">
      <Icon name="clock" />
      Rest until <span className="rest-marker__time">{until}</span>
    </span>
  )
}
