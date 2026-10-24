import { Icon } from './Icon'

// When a player's rest ends, styled by `.fm-rest` in styles/kit.css: a blue
// clock and the time. Information, not a problem.
export function RestIndicator({ until }: { until: string }) {
  return (
    <span className="fm-rest">
      <Icon name="clock" />
      Rest until <span className="num">{until}</span>
    </span>
  )
}
