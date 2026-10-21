import type { ReactNode } from 'react'

// A titled section of a page: a display heading with a lead line under it,
// then the section's content. Styled by `.section` in styles/base.css.
export function Section({
  id,
  title,
  lead,
  children,
}: {
  id?: string
  title: string
  lead: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="section" id={id} aria-label={title}>
      <h2>{title}</h2>
      <p className="lead">{lead}</p>
      {children}
    </section>
  )
}
