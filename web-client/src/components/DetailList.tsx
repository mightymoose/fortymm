import type { ReactNode } from 'react'

// One label and its value. A `numeric` value is set in the number font.
export type Detail = { term: string; value: ReactNode; numeric?: boolean }

// Grouped details, label over value, styled by `.fm-dl` in styles/kit.css.
// They flow into as many columns as fit.
export function DetailList({ details }: { details: readonly Detail[] }) {
  return (
    <dl className="fm-dl">
      {details.map(({ term, value, numeric }) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd className={numeric ? 'num' : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
