import type { ReactNode } from 'react'
import { Icon } from './Icon.tsx'
import './StatusMarker.css'

export type Status = 'offline' | 'conflict' | 'danger'

// The design system's status markers (.fm-status): a state that needs to be
// seen, in a word and a mark as well as a colour. Offline is a ring in
// --fg-3 ("Offline · updated 11:42"); a conflict that needs a decision a
// warning triangle in --conflict; danger (withdrawn, failed) an alert circle
// in --danger. The marks are decoration: the words say it.
export function StatusMarker({
  status,
  children,
}: {
  status: Status
  children: ReactNode
}) {
  return (
    <span className={`status-marker status-marker--${status}`}>
      {status === 'conflict' && <Icon name="triangle-alert" />}
      {status === 'danger' && <Icon name="circle-alert" />}
      {children}
    </span>
  )
}
