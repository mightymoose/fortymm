import { type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.tsx'

export type StatusTone = 'conflict' | 'danger' | 'offline'

// The cue each tone carries besides its hue: an icon, or (offline) kit.css's hollow dot.
const icons: Partial<Record<StatusTone, IconName>> = {
  conflict: 'triangle-alert',
  danger: 'circle-alert',
}

// A status marker: a short status in its tone's colour, with its cue, e.g. "Needs decision"
// (conflict), "Didn't sync" (danger), "Scorer offline" (offline). Static text, not announced.
export function StatusMarker({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const icon = icons[tone]
  return (
    <span className={`fm-status fm-status--${tone}`}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  )
}
