import type { ButtonHTMLAttributes, MouseEvent } from 'react'
import type { ForcedState } from './forced-state.ts'
import './Button.css'

// The design system's button (its Buttons component): a real <button>, in one
// of six variants and four sizes.
//
// - primary: the one main action of a card or dialog, in the accent.
// - secondary, ghost: every other action; ghost for low-emphasis ones.
// - danger: a destructive action that asks to be confirmed ("Withdraw…"),
//   text and outline only; danger-solid: the confirmation itself.
// - link: an action that reads as a link.
//
// Disabled looks the same under the pointer. While `loading`, the button
// keeps its variant's colours, shows a static ring, says so to assistive
// technology (aria-busy) and ignores clicks; give it a label that says what
// is happening ("Saving…").
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'danger-solid'
  | 'link'

export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'aria-busy'
> & {
  variant: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  forcedState?: ForcedState
} & (
    | { iconOnly?: false }
    // A button that shows only an icon has no text to name it: it must be
    // given a name.
    | { iconOnly: true; 'aria-label': string }
  )

export function Button({
  variant,
  size = 'md',
  iconOnly = false,
  loading = false,
  forcedState,
  type = 'button',
  onClick,
  ...props
}: ButtonProps) {
  const className = [
    'button',
    `button--${variant}`,
    size !== 'md' && `button--${size}`,
    iconOnly && 'button--icon',
  ]
    .filter(Boolean)
    .join(' ')

  function click(event: MouseEvent<HTMLButtonElement>) {
    if (loading) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }

  return (
    <button
      {...props}
      type={type}
      className={className}
      aria-busy={loading || undefined}
      data-forced-state={forcedState}
      onClick={click}
    />
  )
}
