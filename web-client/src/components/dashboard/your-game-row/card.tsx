import type { ComponentProps, ReactNode } from 'react'

import { Card as UICard } from '@/components/ui/card'

export interface CardProps extends Omit<ComponentProps<'div'>, 'children'> {
  children: ReactNode
  padding?: number | string
}

/**
 * The shared design-system Card (`@/components/ui/card`). `display: 'block'`
 * neutralizes the shadcn Card's default flex/gap so callers keep full control of
 * their inner layout (e.g. RatingCard re-enables flex via its own style;
 * RecentResultsCard stays block).
 */
export const Card = ({
  children,
  padding = 20,
  style,
  className,
  ...rest
}: CardProps) => (
  <UICard
    className={className}
    style={{
      display: 'block',
      padding,
      position: 'relative',
      ...style,
    }}
    {...rest}
  >
    {children}
  </UICard>
)
