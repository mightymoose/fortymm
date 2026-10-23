export type BreadcrumbItem = {
  label: string
  href?: string
}

// The trail of pages from the top of the app down to this one, as in the
// WAI-ARIA breadcrumb pattern: a navigation landmark holding a list of
// links, the last item the current page. Styled by `.breadcrumb` in
// styles/base.css. The slashes between the items are hidden from assistive
// tech, which reads the list instead.
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol>
        {items.map((item, index) =>
          index === items.length - 1 ? (
            <li key={index}>
              <span aria-current="page" className="breadcrumb-current">
                {item.label}
              </span>
            </li>
          ) : (
            <li key={index}>
              {item.href === undefined ? (
                item.label
              ) : (
                <a href={item.href}>{item.label}</a>
              )}
              <span className="breadcrumb-separator" aria-hidden="true">
                /
              </span>
            </li>
          ),
        )}
      </ol>
    </nav>
  )
}
