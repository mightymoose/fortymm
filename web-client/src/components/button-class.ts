import type { ButtonSize, ButtonVariant } from './Button.tsx'

// The classes that give an element the button's look (Button.css), for
// Button and for ButtonLink (a link that looks like a button).
export function buttonClassName({
  variant,
  size = 'md',
  iconOnly = false,
}: {
  variant: ButtonVariant
  size?: ButtonSize
  iconOnly?: boolean
}) {
  return [
    'button',
    `button--${variant}`,
    size !== 'md' && `button--${size}`,
    iconOnly && 'button--icon',
  ]
    .filter(Boolean)
    .join(' ')
}
