import type { ComponentProps } from 'react'

export type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'link'

export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

// A button in one of the design system's variants and sizes, styled by
// `.button` in styles/base.css. Other props go to the <button> as is.
export function Button({
  variant = 'default',
  size = 'default',
  type = 'button',
  className,
  ...props
}: ComponentProps<'button'> & {
  variant?: ButtonVariant
  size?: ButtonSize
}) {
  const classes = ['button', `button--${variant}`]
  if (size !== 'default') classes.push(`button--${size}`)
  if (className) classes.push(className)
  return <button type={type} className={classes.join(' ')} {...props} />
}
