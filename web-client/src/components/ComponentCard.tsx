import type { ReactNode } from 'react'

// A card showing one component: a header with the component's name and a
// mono tag beside it, then the demo. Styled by `.component-card` in
// styles/base.css.
export function ComponentCard({
  title,
  tag,
  children,
}: {
  title: string
  tag: string
  children: ReactNode
}) {
  return (
    <article className="component-card" aria-label={title}>
      <div className="component-card-header">
        <h3>{title}</h3>
        <span className="tag">{tag}</span>
      </div>
      {children}
    </article>
  )
}
