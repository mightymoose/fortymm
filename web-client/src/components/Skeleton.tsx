import type { CSSProperties } from 'react'

export type SkeletonShape = 'rect' | 'circle'

// A shimmering placeholder where content will load, styled by `.skeleton`
// in styles/base.css. It stands in for content that isn't there yet, so it
// is hidden from assistive tech.
export function Skeleton({
  shape = 'rect',
  width,
  height,
}: {
  shape?: SkeletonShape
  width: CSSProperties['width']
  height: CSSProperties['height']
}) {
  return (
    <div
      className={shape === 'circle' ? 'skeleton skeleton--circle' : 'skeleton'}
      style={{ width, height }}
      aria-hidden="true"
    />
  )
}
