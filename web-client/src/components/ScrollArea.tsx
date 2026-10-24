import type { CSSProperties, ReactNode } from 'react'

// A scroll area inside its card, with no frame of its own, styled by
// `.fm-scroll` in styles/kit.css: a thin scrollbar, and the `heading`, if
// any, sticks to its top. With a `label` it's a tab stop, so keyboard users
// can scroll it.
export function ScrollArea({
  label,
  heading,
  style,
  children,
}: {
  label?: string
  heading?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <div
      className="fm-scroll"
      style={style}
      tabIndex={label ? 0 : undefined}
      aria-label={label}
    >
      {heading && <div className="fm-scroll__head">{heading}</div>}
      {children}
    </div>
  )
}
