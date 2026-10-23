import { useId, useState, type ReactNode } from 'react'

export type AccordionItem = {
  value: string
  title: string
  content: ReactNode
}

// A stack of collapsible items, each a heading over its content, as in the
// WAI-ARIA accordion pattern. Styled by `.accordion-item` in
// styles/base.css. Each heading holds a button that shows or hides the
// item's content, and the items open and close independently.
//
// It's uncontrolled: `defaultOpen` lists the items open at first.
// `headingLevel` has no default: the headings' level depends on where the
// accordion sits in the page's outline, so each caller picks it.
export function Accordion({
  items,
  defaultOpen = [],
  headingLevel,
}: {
  items: AccordionItem[]
  defaultOpen?: string[]
  headingLevel: 2 | 3 | 4 | 5 | 6
}) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  const Heading = `h${headingLevel}` as const

  function toggle(value: string) {
    setOpen((current) =>
      current.includes(value)
        ? current.filter((other) => other !== value)
        : [...current, value],
    )
  }

  return (
    <div className="accordion">
      {items.map((item) => {
        const expanded = open.includes(item.value)
        const triggerId = `${id}-trigger-${item.value}`
        const contentId = `${id}-content-${item.value}`
        return (
          <div key={item.value} className="accordion-item">
            <Heading className="accordion-heading">
              <button
                type="button"
                id={triggerId}
                aria-expanded={expanded}
                aria-controls={contentId}
                className="accordion-trigger"
                onClick={() => toggle(item.value)}
              >
                {item.title}
                <span className="accordion-chevron" aria-hidden="true">
                  ⌄
                </span>
              </button>
            </Heading>
            <div
              role="region"
              id={contentId}
              aria-labelledby={triggerId}
              hidden={!expanded}
              className="accordion-content"
            >
              {item.content}
            </div>
          </div>
        )
      })}
    </div>
  )
}
