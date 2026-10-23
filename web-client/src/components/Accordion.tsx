import { useId, useState, type ReactNode } from 'react'

export type AccordionItem = {
  value: string
  title: string
  content: ReactNode
}

// A stack of collapsible items, each a heading over its content, as in the
// WAI-ARIA accordion pattern. Styled by `.accordion-item` in
// styles/base.css. Each heading holds a button that shows or hides the
// item's content. At most one item is open: opening one closes the open
// one, and clicking the open one closes it.
//
// It's uncontrolled: `defaultOpen` is the item open at first, none unless
// given.
// `headingLevel` has no default: the headings' level depends on where the
// accordion sits in the page's outline, so each caller picks it.
export function Accordion({
  items,
  defaultOpen,
  headingLevel,
}: {
  items: AccordionItem[]
  defaultOpen?: string
  headingLevel: 2 | 3 | 4 | 5 | 6
}) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  const Heading = `h${headingLevel}` as const

  function toggle(value: string) {
    setOpen((current) => (current === value ? undefined : value))
  }

  return (
    <div className="accordion">
      {items.map((item) => {
        const expanded = item.value === open
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
