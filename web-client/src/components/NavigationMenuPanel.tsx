export type NavigationMenuLink = {
  title: string
  description: string
  href: string
}

// The panel a navigation menu opens under one of its items: a two-column
// list of links, each a title over a line describing it. Styled by
// `.nav-menu` in styles/base.css. Name the list with `label`, e.g. the
// menu item that opens it.
export function NavigationMenuPanel({
  label,
  items,
}: {
  label: string
  items: NavigationMenuLink[]
}) {
  return (
    <ul className="nav-menu" aria-label={label}>
      {items.map((link) => (
        <li key={link.title}>
          <a href={link.href} className="nav-menu-link">
            <p className="nav-menu-title">{link.title}</p>
            <p className="nav-menu-description">{link.description}</p>
          </a>
        </li>
      ))}
    </ul>
  )
}
