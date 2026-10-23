import type { ReactNode } from 'react'

// A box as wide as its container whose height keeps `ratio` (width over
// height, e.g. 16 / 9), for media that loads later. Styled by
// `.aspect-ratio` in styles/base.css.
export function AspectRatio({
  ratio,
  children,
}: {
  ratio: number
  children?: ReactNode
}) {
  return (
    <div className="aspect-ratio" style={{ aspectRatio: ratio }}>
      {children}
    </div>
  )
}
