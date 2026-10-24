import { useId, type CSSProperties, type ReactNode } from 'react'

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
    <section
      className="doc-cat"
      id={id}
      aria-labelledby={headingId}
      data-testid={`section-${id}`}
    >
      <h2 id={headingId}>{title}</h2>
      <p>{lead}</p>
      {children}
    </section>
  )
}

// One example in a section, as the gallery draws its `.doc-ex`: a title and
// a description beside the demo. `testId` is the gallery's, e.g.
// `ex-variants`. `style`, `headerStyle` and `stageStyle` copy an inline
// style the gallery puts on an example's `.doc-ex`, its `<header>` or its
// `.doc-stage`.
export function Example({
  testId,
  title,
  description,
  style,
  headerStyle,
  stageStyle,
  children,
}: {
  testId: string
  title: string
  description?: ReactNode
  style?: CSSProperties
  headerStyle?: CSSProperties
  stageStyle?: CSSProperties
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <article className="doc-ex" style={style} aria-labelledby={titleId} data-testid={testId}>
      <header style={headerStyle}>
        <h3 id={titleId}>{title}</h3>
        {description && <p>{description}</p>}
      </header>
      <div className="doc-stage" style={stageStyle}>
        {children}
      </div>
    </article>
  )
}
