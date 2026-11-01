// A list's loading state in the shape of its table: the toolbar's line,
// then a few rows. `label` is what a screen reader hears, such as "Loading
// roles".
export function TableSkeleton({ label }: { label: string }) {
  return (
    <div className="admin-skeleton" aria-busy="true">
      <span className="fm-sr" role="status">
        {label}
      </span>
      <div className="fm-skeleton admin-skeleton__bar" aria-hidden="true" />
      {[0, 1, 2].map((row) => (
        <div key={row} className="fm-skeleton admin-skeleton__row" aria-hidden="true" />
      ))}
    </div>
  )
}
