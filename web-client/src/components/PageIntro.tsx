import type { ReactNode } from 'react'

// The intro paragraph under a page's header, styled by `.page-intro` in
// styles/base.css. Its negative top margin pulls it up into the space below
// the header, so it belongs right after a PageHeader.
export function PageIntro({ children }: { children: ReactNode }) {
  return <p className="page-intro">{children}</p>
}
