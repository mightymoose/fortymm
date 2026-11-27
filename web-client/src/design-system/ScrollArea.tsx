import { type ReactNode } from 'react'

// A scroll area (fm-scroll): content bigger than its place, scrolled inside its card with no frame
// of its own. `header` is a column heading that sticks to the top. It is a named region in the tab
// order, so keyboard users can scroll it.
//
// - maxHeight: how tall it grows before it scrolls down.
// - isHorizontal: it scrolls sideways (e.g. a timeline); it keeps 8px under its content, so what
//   hangs below the content (a timeline's now line) stays clear of the scrollbar.
export function ScrollArea({
  label,
  header,
  maxHeight,
  isHorizontal,
  children,
}: {
  label: string
  header?: ReactNode
  maxHeight?: number
  isHorizontal?: boolean
  children: ReactNode
}) {
  return (
    <div
      className="fm-scroll"
      style={{ maxHeight, paddingBottom: isHorizontal ? 8 : undefined }}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {header && <div className="fm-scroll__head">{header}</div>}
      {children}
    </div>
  )
}
