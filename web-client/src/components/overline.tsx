import type { CSSProperties, ElementType, ReactNode } from 'react'

import { cn } from '@/lib/utils'

type OverlineProps = {
  as?: ElementType
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function Overline({
  as,
  children,
  className,
  style,
}: OverlineProps) {
  const Tag = as ?? 'div'
  return (
    <Tag className={cn('fortymm-overline', className)} style={style}>
      {children}
    </Tag>
  )
}
