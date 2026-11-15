import { Link, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { ButtonSize, ButtonVariant } from './Button.tsx'
import { buttonClassName } from './button-class.ts'
import './Button.css'
import './ButtonLink.css'

// A link that looks like a button (Button's look, on the router's <Link>):
// for an action that goes to another page, such as "New match". It is a
// link, so a person and assistive technology know it navigates, and it can
// be opened in a new tab.
// The link variant is left out: a plain <Link> is that.
export function ButtonLink({
  to,
  variant,
  size,
  className,
  children,
}: {
  to: LinkProps['to']
  variant: Exclude<ButtonVariant, 'danger' | 'danger-solid' | 'link'>
  size?: ButtonSize
  // A class of the screen's own, for where the link sits on it.
  className?: string
  children: ReactNode
}) {
  const classes = [buttonClassName({ variant, size }), className]
    .filter(Boolean)
    .join(' ')
  return (
    <Link to={to} className={classes}>
      {children}
    </Link>
  )
}
