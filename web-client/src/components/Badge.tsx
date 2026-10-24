import type { ComponentProps } from 'react'

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'destructive'
  | 'live'

const variantClasses: Record<BadgeVariant, string> = {
  default: 'badge--default',
  secondary: 'badge--secondary',
  outline: 'badge--outline',
  destructive: 'badge--destructive',
  live: 'badge--live',
}

// A short label (a seed, a status, a match type) in one of the design
// system's variants, styled by `.badge` in styles/base.css. A live badge
// starts with the pulsing live dot. Other props go to the <span> as is, e.g.
// aria-describedby for a tooltip.
export function Badge({
  variant = 'default',
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'className'> & {
  variant?: BadgeVariant
}) {
  return (
    <span {...props} className={`badge ${variantClasses[variant]}`}>
      {variant === 'live' && (
        <span className="ball-dot ball-dot--live" aria-hidden="true" />
      )}
      {children}
    </span>
  )
}
