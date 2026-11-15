import './Nav.css'

export type NavItem = {
  label: string
  href: string
  // The page you are on.
  current?: boolean
}

// The design system's navigation (.fm-nav): the pages of one place (a
// tournament's overview, schedule, draws...), as links in a <nav> named by
// `label`. The page you are on is aria-current="page", in --accent-soft
// with --accent-text.
export function Nav({ label, items }: { label: string; items: NavItem[] }) {
  return (
    <nav aria-label={label} className="nav">
      {items.map((item) => (
        <a
          key={item.label}
          href={item.href}
          aria-current={item.current ? 'page' : undefined}
        >
          {item.label}
        </a>
      ))}
    </nav>
  )
}
