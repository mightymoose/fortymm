import { type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.tsx'

export type NoticeTone = 'info' | 'rest' | 'success' | 'warning'

const icons: Record<NoticeTone, IconName> = {
  info: 'info',
  rest: 'clock',
  success: 'check',
  warning: 'triangle-alert',
}

// An inline notice: a line of context that is part of the text around it, with an icon for its
// tone. Not raised, not dismissable; for a problem the user must act on, use an Alert.
export function Notice({ tone = 'info', children }: { tone?: NoticeTone; children: ReactNode }) {
  return (
    <p className={tone === 'info' ? 'fm-notice' : `fm-notice fm-notice--${tone}`}>
      <Icon name={icons[tone]} />
      <span>{children}</span>
    </p>
  )
}
