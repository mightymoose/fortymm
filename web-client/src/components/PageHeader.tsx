// The header at the top of every page: a display title with a mono
// subtitle beside it, styled by `.page-header` in styles/base.css.
export function PageHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle: string
}) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <span className="sub">{subtitle}</span>
    </header>
  )
}
