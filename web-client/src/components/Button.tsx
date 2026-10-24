import type { ComponentProps } from 'react'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'danger-solid'
  | 'link'

export type ButtonSize = 'sm' | 'default' | 'lg' | 'xl'

// A button in one of the design system's variants and sizes, styled by
// `.fm-btn` in styles/kit.css. `icon` makes it square, for a lone icon and
// an aria-label. `busy` shows the spinner, for a label like "Saving…".
// With aria-disabled it stays focusable, so the reason it's off can be read,
// but a click does nothing. Other props go to the <button> as is.
export function Button({
  variant,
  size = 'default',
  icon = false,
  busy = false,
  type = 'button',
  className,
  onClick,
  ...props
}: ComponentProps<'button'> & {
  variant: ButtonVariant
  size?: ButtonSize
  icon?: boolean
  busy?: boolean
}) {
  const classes = ['fm-btn', `fm-btn--${variant}`]
  if (size !== 'default') classes.push(`fm-btn--${size}`)
  if (icon) classes.push('fm-btn--icon')
  if (className) classes.push(className)
  const unavailable =
    props['aria-disabled'] === true || props['aria-disabled'] === 'true'
  return (
    <button
      type={type}
      className={classes.join(' ')}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      }}
      {...props}
    />
  )
}
