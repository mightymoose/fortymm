import { type CSSProperties, type ReactNode, useRef, useState } from 'react'
import { useMove } from 'react-aria'

// How far one arrow key press moves the handle, in percent of the view's width.
const keyboardStep = 2

// A split view (fm-split): two panes side by side, separated by space and a handle that resizes
// them. The handle is a focusable separator (the ARIA window splitter): drag it, or move it with
// the arrow keys. Its value is the start pane's share of the width, in percent, from minValue to
// maxValue; `label` names what it resizes. In a narrow container kit.css stacks the panes and hides
// the handle.
export function SplitView({
  label,
  defaultValue,
  minValue,
  maxValue,
  start,
  end,
}: {
  label: string
  defaultValue: number
  minValue: number
  maxValue: number
  start: ReactNode
  end: ReactNode
}) {
  const [value, setValue] = useState(defaultValue)
  const ref = useRef<HTMLDivElement>(null)
  const { moveProps } = useMove({
    onMove({ deltaX, pointerType }) {
      const width = ref.current?.getBoundingClientRect().width ?? 0
      const delta = pointerType === 'keyboard' ? deltaX * keyboardStep : (deltaX / width) * 100
      if (Number.isFinite(delta)) {
        setValue((current) => Math.min(maxValue, Math.max(minValue, current + delta)))
      }
    },
  })
  return (
    <div className="fm-split-host">
      <div className="fm-split" ref={ref} style={{ '--split': `${value}%` } as CSSProperties}>
        <div style={{ minWidth: 0 }}>{start}</div>
        <button
          {...moveProps}
          type="button"
          className="fm-split__handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-valuemin={minValue}
          aria-valuemax={maxValue}
          aria-valuenow={Math.round(value)}
        />
        <div>{end}</div>
      </div>
    </div>
  )
}
