import { useId, type ReactNode } from 'react'

// One section of the design system page, as the reference gallery draws its
// `.doc-cat`: a heading, a lead line, then its examples.
export function GallerySection({
  id,
  title,
  lead,
  children,
}: {
  id: string
  title: string
  lead: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section className="doc-cat" id={id} aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p>{lead}</p>
      {children}
    </section>
  )
}

// One example in a section, as the gallery draws its `.doc-ex`: a title and
// a description beside the demo.
export function Example({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <article className="doc-ex" aria-labelledby={titleId}>
      <header>
        <h3 id={titleId}>{title}</h3>
        {description && <p>{description}</p>}
      </header>
      <div className="doc-stage">{children}</div>
    </article>
  )
}
