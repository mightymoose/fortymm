import type { ReactNode } from 'react'
import './Disclosure.css'

// The design system's disclosure (.fm-disclosure): a summary that opens to
// show more about it, one of a list of them. A real <details>, so the
// browser opens and closes it with a click, Enter or Space, and says
// whether it is open. `defaultOpen` shows it open at first.
export function Disclosure({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details className="disclosure" open={defaultOpen || undefined}>
      <summary>{summary}</summary>
      <p>{children}</p>
    </details>
  )
}
