import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon.tsx'
import './Notice.css'

export type NoticeTone = 'info' | 'rest' | 'success' | 'warning'

const icons: Record<NoticeTone, IconName> = {
  info: 'info',
  rest: 'clock',
  success: 'circle-check',
  warning: 'triangle-alert',
}

// The design system's notice (.fm-notice): one sentence in the flow of the
// page, with an icon for its tone. Plain information, a rest, a success or
// a warning that needs no action (one that does is an Alert). A paragraph;
// `<b>` in it marks what to notice ("published at <b>9:30</b>").
export function Notice({
  tone = 'info',
  children,
}: {
  tone?: NoticeTone
  children: ReactNode
}) {
  return (
    <p className={`notice notice--${tone}`}>
      <Icon name={icons[tone]} />
      <span>{children}</span>
    </p>
  )
}
