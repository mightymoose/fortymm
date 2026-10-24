import { useId, type ReactNode } from 'react'

// A short label shown above what it explains, as in the WAI-ARIA tooltip
// pattern: a `.tooltip` holding the trigger, then the `.tooltip-bubble`
// with role tooltip (styles/base.css). `children` renders the trigger from
// the bubble's id, to set as its aria-describedby. It's shown in place,
// open. It doesn't open on hover or focus, or close.
export function Tooltip({
  text,
  children,
}: {
  text: string
  children: (tooltipId: string) => ReactNode
}) {
  const id = useId()
  return (
    <span className="tooltip">
      {children(id)}
      <span role="tooltip" id={id} className="tooltip-bubble">
        {text}
      </span>
    </span>
  )
}
