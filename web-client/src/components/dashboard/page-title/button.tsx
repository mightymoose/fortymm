import type { CSSProperties, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { C, UI } from '@/components/dashboard/dashboard-tokens'

export type ButtonKind = 'primary' | 'secondary' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

const buttonSizes = {
  sm: { h: 32, px: 12, font: 13 },
  md: { h: 40, px: 16, font: 14 },
  lg: { h: 52, px: 24, font: 16 },
}

const buttonKinds: Record<ButtonKind, CSSProperties> = {
  primary: {
    background: C.ball500,
    color: C.ink950,
    border: '1px solid transparent',
    boxShadow:
      '0 4px 14px rgba(255,122,26,0.35), inset 0 1px 0 rgba(255,255,255,0.18)',
  },
  secondary: {
    background: 'transparent',
    color: C.chalk100,
    border: `1px solid ${C.ink500}`,
  },
  ghost: {
    background: 'transparent',
    color: C.chalk300,
    border: '1px solid transparent',
  },
}

export interface ButtonProps {
  children: ReactNode
  kind?: ButtonKind
  size?: ButtonSize
  iconLeft?: ReactNode
  iconRight?: ReactNode
  fullWidth?: boolean
  style?: CSSProperties
  /** When set, renders a TanStack Router Link with the same styling instead of a <button>. */
  to?: string
  params?: Record<string, string>
}

/** The dashboard's primary call-to-action. Renders a styled `<button>` by
 * default, or a TanStack Router `<Link>` when `to` is set, sharing the same
 * kind/size styling either way. */
export const Button = ({
  children,
  kind = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  fullWidth = false,
  style,
  to,
  params,
}: ButtonProps) => {
  const s = buttonSizes[size]
  const composed: CSSProperties = {
    height: s.h,
    padding: `0 ${s.px}px`,
    borderRadius: 8,
    font: `600 ${s.font}px ${UI}`,
    letterSpacing: '0.005em',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    width: fullWidth ? '100%' : 'auto',
    textDecoration: 'none',
    ...buttonKinds[kind],
    ...style,
  }
  const body = (
    <>
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </>
  )
  if (to) {
    return (
      <Link to={to} params={params} style={composed}>
        {body}
      </Link>
    )
  }
  return (
    <button type="button" style={composed}>
      {body}
    </button>
  )
}
