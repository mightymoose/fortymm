import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isTestMode } from '../testMode'
import { TOOLTIP_ID, TooltipContext, type TooltipControls } from './tooltipContext'

// How long the pointer rests on a control before its tooltip shows.
export const TOOLTIP_DELAY_MS = 300

// The space kept between a tooltip, its trigger and the viewport's edges.
const GAP = 8

type Shown = { key: string; text: string; trigger: HTMLElement }

// Gives the app useTooltip() and shows the page's one tooltip, styled by
// `.fm-tooltip` in styles/kit.css, as kit.js does. It shows after the
// pointer rests on its trigger for TOOLTIP_DELAY_MS (at once in test mode),
// or when the trigger gets keyboard focus. It sits above the trigger, or
// below when there's no room above, inside the viewport. Esc, a scroll and
// leaving the trigger hide it.
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const hide = useCallback(() => {
    clearTimeout(timer.current)
    setShown(null)
  }, [])

  const controls = useMemo<Omit<TooltipControls, 'owner'>>(
    () => ({
      hover(key, text, trigger) {
        clearTimeout(timer.current)
        timer.current = setTimeout(
          () => setShown({ key, text, trigger }),
          isTestMode() ? 0 : TOOLTIP_DELAY_MS,
        )
      },
      leave(trigger) {
        clearTimeout(timer.current)
        if (document.activeElement !== trigger) setShown(null)
      },
      focus(key, text, trigger) {
        if (trigger.matches(':focus-visible')) setShown({ key, text, trigger })
      },
      hide,
    }),
    [hide],
  )

  // Measured once the text is in, so it fits the tooltip's own size. The
  // tooltip keeps its last place while hidden, as kit.js's does.
  useLayoutEffect(() => {
    const element = tooltip.current
    if (!shown || !element) return
    const box = shown.trigger.getBoundingClientRect()
    const width = element.offsetWidth
    const height = element.offsetHeight
    let top = box.top - height - GAP
    if (top < GAP) top = box.bottom + GAP
    const left = Math.max(
      GAP,
      Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - GAP),
    )
    element.style.top = `${top + window.scrollY}px`
    element.style.left = `${left + window.scrollX}px`
  }, [shown])

  useEffect(() => {
    if (!shown) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', hide, true)
    }
  }, [shown, hide])

  useEffect(() => () => clearTimeout(timer.current), [])

  const value = useMemo(() => ({ ...controls, owner: shown?.key ?? null }), [controls, shown])

  return (
    <TooltipContext value={value}>
      {children}
      {/* On <body>, as kit.js puts it, so the gallery's `only` test mode
          keeps it on screen. */}
      {createPortal(
        <div
          ref={tooltip}
          className="fm-tooltip"
          id={TOOLTIP_ID}
          role="tooltip"
          hidden={!shown}
        >
          {shown?.text}
        </div>,
        document.body,
      )}
    </TooltipContext>
  )
}
