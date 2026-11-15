import './Skeleton.css'

// The design system's skeleton (.fm-skeleton): where content will be while
// it loads, as a flat block of its size. Static: no shimmer. Decoration;
// whatever is loading says so in words.
export function Skeleton({ width, height }: { width: string; height: string }) {
  return (
    <div className="skeleton" aria-hidden="true" style={{ width, height }} />
  )
}
