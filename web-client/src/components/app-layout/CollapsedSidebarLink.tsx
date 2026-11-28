import { Link } from '@tanstack/react-router'
import { useId, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../design-system/Icon.tsx'
import type { SidebarLinkTarget } from './sidebar-links.ts'

// A collapsed sidebar's link: its icon, named by its tooltip (the kit's .fm-tooltip), which shows
// beside the icon while the pointer is over it or it has focus, until Escape. The tooltip is fixed
// beside the link and rendered on the document's body: the sidebar's links are sticky, which makes
// a stacking context of their own, so inside them the page's later content would be drawn over it.
export function CollapsedSidebarLink({ to, label, icon }: SidebarLinkTarget) {
  const tooltipId = useId()
  const [at, setAt] = useState<CSSProperties | null>(null)

  function show(event: { currentTarget: HTMLElement }) {
    const box = event.currentTarget.getBoundingClientRect()
    setAt({ top: box.top + box.height / 2, left: box.right + 8 })
  }
  const hide = () => setAt(null)

  return (
    <>
      <Link
        to={to}
        className="sidebar__item"
        aria-labelledby={tooltipId}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hide()
        }}
      >
        <Icon name={icon} />
      </Link>
      {createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          className="fm-tooltip sidebar__tooltip"
          hidden={at === null}
          style={at ?? undefined}
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  )
}
