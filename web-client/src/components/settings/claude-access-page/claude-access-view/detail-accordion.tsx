import { ChevronDown } from 'lucide-react'

/** One line of an accordion: the thing being explained, and the explanation. */
export interface DetailAccordionItem {
  /** The lead-in, rendered in bold — e.g. `Matches`. */
  term: string
  /** The rest of the line, rendered after an em dash. */
  detail: string
}

export interface DetailAccordionProps {
  title: string
  items: DetailAccordionItem[]
}

/**
 * A closed-by-default disclosure of secondary detail.
 *
 * Native `<details>`/`<summary>`, not a scripted toggle: the summary is already
 * a real, keyboard-operable control with correct expanded/collapsed semantics,
 * and it keeps working before hydration and inside a browser's find-in-page.
 * The chevron rotates from CSS off `details[open]`, so nothing here has to
 * track open state.
 */
export function DetailAccordion({ title, items }: DetailAccordionProps) {
  return (
    <details className="fmm-claude__accordion">
      <summary className="fmm-claude__accordion-summary">
        <span>{title}</span>
        <ChevronDown
          className="fmm-claude__accordion-chevron"
          aria-hidden="true"
          size={18}
        />
      </summary>
      <ul className="fmm-claude__accordion-list">
        {items.map((item) => (
          <li className="fmm-claude__accordion-item" key={item.term}>
            <strong className="fmm-claude__accordion-term">{item.term}</strong> —{' '}
            {item.detail}
          </li>
        ))}
      </ul>
    </details>
  )
}
