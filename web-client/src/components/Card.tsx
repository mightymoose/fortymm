import { useId, type ReactNode } from 'react'

// A card holding one piece of content: a header with a title and an
// optional description, the body, then an optional footer (e.g. buttons).
// Styled by `.card` in styles/base.css. The article is named by its title.
//
// `headingLevel` has no default: the title's level depends on where the
// card sits in the page's outline, so each caller picks it.
export function Card({
  title,
  description,
  footer,
  children,
  variant = 'default',
  headingLevel,
}: {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  children: ReactNode
  variant?: 'default' | 'featured'
  headingLevel: 2 | 3 | 4 | 5 | 6
}) {
  const titleId = useId()
  const Heading = `h${headingLevel}` as const
  return (
    <article
      className={variant === 'featured' ? 'card card--featured' : 'card'}
      aria-labelledby={titleId}
    >
      <div className="card-header">
        <Heading className="card-title" id={titleId}>
          {title}
        </Heading>
        {description !== undefined && (
          <p className="card-description">{description}</p>
        )}
      </div>
      <div className="card-body">{children}</div>
      {footer !== undefined && <div className="card-footer">{footer}</div>}
    </article>
  )
}
