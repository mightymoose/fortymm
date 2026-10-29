import { Icon } from './Icon'

// When a rate-limited visitor can try again, from the 429's Retry-After.
export function RetryTime({ at }: { at: Date }) {
  return (
    <span className="fm-rest">
      <Icon name="clock" />
      <span>
        Try again at{' '}
        <span className="num">
          {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
    </span>
  )
}
