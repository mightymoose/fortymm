import { type ReactNode } from 'react'

export interface Description {
  term: string
  details: ReactNode
  // Details that are a number (a rating, a count) are set in the numeric face.
  isNumeric?: boolean
}

// A description list (fm-dl): a card's grouped details, as term and details pairs that flow into
// as many columns as fit.
export function DescriptionList({ items }: { items: Description[] }) {
  return (
    <dl className="fm-dl">
      {items.map(({ term, details, isNumeric }) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd className={isNumeric ? 'num' : undefined}>{details}</dd>
        </div>
      ))}
    </dl>
  )
}
