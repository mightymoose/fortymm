import './DescriptionList.css'

export type Description = {
  term: string
  detail: string
  // A number, time or score: set in figures.
  numeric?: boolean
}

// The design system's details list (.fm-dl): labels and their values, side
// by side as the width allows, as a card's body shows them. A real <dl>.
export function DescriptionList({ items }: { items: Description[] }) {
  return (
    <dl className="description-list">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd className={item.numeric ? 'num' : undefined}>{item.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
