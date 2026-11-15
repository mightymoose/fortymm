import type { ReactNode } from 'react'
import './Card.css'

// The design system's card (.fm-card): persistent information about one
// thing, on --bg-panel with no border. Its title (a heading, at
// `headingLevel` where it sits in the page) and a line under it, its status
// at the top right, its details in the body, and its actions at the bottom
// left, the primary first.
export function Card({
  title,
  subtitle,
  status,
  headingLevel = 3,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  status?: ReactNode
  headingLevel?: 2 | 3 | 4
  actions?: ReactNode
  children: ReactNode
}) {
  const Heading = `h${headingLevel}` as const
  return (
    <article className="card">
      <div className="card__head">
        <div>
          <Heading className="card__title">{title}</Heading>
          {subtitle !== undefined && <p className="card__sub">{subtitle}</p>}
        </div>
        {status}
      </div>
      <div className="card__body">{children}</div>
      {actions !== undefined && <div className="card__foot">{actions}</div>}
    </article>
  )
}
