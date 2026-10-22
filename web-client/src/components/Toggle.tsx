import { useState, type ComponentProps } from 'react'

// A button that stays pressed or unpressed: a <button> with aria-pressed,
// styled by `.toggle` in styles/base.css. A click, Space or Enter flips it,
// as on any button.
//
// `pressed`/`onPressedChange` control the state; `defaultPressed` sets it
// otherwise. It carries its own name (its text, or an aria-label where the
// text is a symbol), so it isn't wired to a Field.
export function Toggle({
  pressed,
  defaultPressed = false,
  onPressedChange,
  onClick,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'type' | 'aria-pressed'> & {
  pressed?: boolean
  defaultPressed?: boolean
  onPressedChange?: (pressed: boolean) => void
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultPressed)
  const isPressed = pressed ?? uncontrolled
  return (
    <button
      type="button"
      aria-pressed={isPressed}
      className={className ? `toggle ${className}` : 'toggle'}
      onClick={(event) => {
        onClick?.(event)
        if (pressed === undefined) setUncontrolled(!isPressed)
        onPressedChange?.(!isPressed)
      }}
      {...props}
    />
  )
}
