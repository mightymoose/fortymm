import { createContext, useContext, useId, type FocusEvent, type PointerEvent } from 'react'

// The id of the page's one tooltip, which its trigger is described by.
export const TOOLTIP_ID = 'fm-tooltip'

export type TooltipControls = {
  // The trigger whose tooltip shows, by its useTooltip() key, or null.
  owner: string | null
  hover: (key: string, text: string, trigger: HTMLElement) => void
  leave: (trigger: HTMLElement) => void
  focus: (key: string, text: string, trigger: HTMLElement) => void
  hide: () => void
}

export const TooltipContext = createContext<TooltipControls | null>(null)

// The props that give a control the tooltip `text`, for the TooltipProvider
// to show on hover and keyboard focus. Spread them on the control. A
// tooltip only adds detail: the control's own name must say what it does.
export function useTooltip(text: string) {
  const controls = useContext(TooltipContext)
  if (!controls) throw new Error('useTooltip() needs a TooltipProvider above it')
  const key = useId()
  return {
    'aria-describedby': controls.owner === key ? TOOLTIP_ID : undefined,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch') controls.hover(key, text, event.currentTarget)
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => controls.leave(event.currentTarget),
    onFocus: (event: FocusEvent<HTMLElement>) => controls.focus(key, text, event.currentTarget),
    onBlur: () => controls.hide(),
  }
}
