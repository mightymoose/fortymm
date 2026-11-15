import { Fragment } from 'react'
import './Breadcrumbs.css'

export type Crumb = { label: string; href: string }

// The design system's breadcrumbs (.fm-crumbs): where this page sits, from
// the top down, each step a link, then this page, which is
// aria-current="page" and not a link. A <nav> named "Breadcrumb"; the
// slashes between steps are decoration.
export function Breadcrumbs({
  trail,
  current,
}: {
  trail: Crumb[]
  current: string
}) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      {trail.map((crumb) => (
        <Fragment key={crumb.label}>
          <a href={crumb.href}>{crumb.label}</a>
          <span aria-hidden="true">/</span>
        </Fragment>
      ))}
      <span aria-current="page">{current}</span>
    </nav>
  )
}
