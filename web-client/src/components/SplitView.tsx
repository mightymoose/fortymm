import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'

// The share of the width the start pane takes, in percent: kit.css's default,
// and the bounds the handle keeps it in.
const START = 58
const MIN = 35
const MAX = 72
// How far one arrow key moves the handle.
const STEP = 4

const clamp = (percent: number) => Math.max(MIN, Math.min(MAX, percent))

// Two panes side by side with a resize handle between them, styled by
// `.fm-split` in styles/kit.css, as kit.js's FM.split runs it. `start` and
// `end` are the panes, one element each. Dragging the handle, or focusing it
// and using ← and →, Home and End, resizes them. `label` names the handle.
// The panes stack and the handle hides when the view is narrower than
// 820px or the window narrower than 900px.
export function SplitView({
  label,
  start,
  end,
}: {
  label: string
  start: ReactElement
  end: ReactElement
}) {
  // Null until the first resize, so kit.css's default holds until then.
  const [percent, setPercent] = useState<number | null>(null)
  const split = useRef<HTMLDivElement>(null)
  const dragFrom = useRef<DOMRect | null>(null)
  const value = Math.round(percent ?? START)

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const targets: Partial<Record<string, number>> = {
      ArrowLeft: value - STEP,
      ArrowRight: value + STEP,
      Home: MIN,
      End: MAX,
    }
    const target = targets[event.key]
    if (target === undefined) return
    event.preventDefault()
    setPercent(clamp(target))
  }

  return (
    <div className="fm-split-host">
      <div
        ref={split}
        className="fm-split"
        style={percent === null ? undefined : ({ '--split': `${percent}%` } as CSSProperties)}
      >
        {start}
        <button
          type="button"
          className="fm-split__handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-valuemin={MIN}
          aria-valuemax={MAX}
          aria-valuenow={value}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            dragFrom.current = split.current!.getBoundingClientRect()
          }}
          onPointerMove={(event) => {
            const box = dragFrom.current
            if (box) setPercent(clamp(((event.clientX - box.left) / box.width) * 100))
          }}
          onPointerUp={() => {
            dragFrom.current = null
          }}
        />
        {end}
      </div>
    </div>
  )
}
