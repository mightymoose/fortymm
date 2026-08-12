import { render, screen, type Container } from '@/test/utilities'
import {
  DetailAccordion,
  type DetailAccordionProps,
} from './detail-accordion'
import { buildDetailAccordionProps } from './detail-accordion.factory'

/** The `<details>` a summary belongs to, or `null` when nothing carries that
 * title. `<summary>` has no stable ARIA role across engines, so the accordion
 * is reached by its visible title and walked up to the element that actually
 * holds the open state. */
function detailsFor(container: Container, title: string) {
  const summary = container.queryByText(title)
  return summary?.closest('details') ?? null
}

const scoped = (container: Container) => ({
  /** The accordion with this title. */
  queryAccordion(title: string) {
    return detailsFor(container, title)
  },
  /** Its summary — the interactive control a user clicks. */
  getSummary(title: string) {
    const summary = detailsFor(container, title)?.querySelector('summary')
    if (!summary) throw new Error(`No accordion titled "${title}".`)
    return summary
  },
  /** Whether it is disclosed. Every accordion starts closed. */
  isOpen(title: string) {
    return detailsFor(container, title)?.hasAttribute('open') ?? false
  },
  /** Its lines, in render order. */
  getItems(title: string) {
    return Array.from(
      detailsFor(container, title)?.querySelectorAll('li') ?? [],
    )
  },
})

/** Test page-object for `DetailAccordion`. */
export const detailAccordionPage = {
  render(overrides: Partial<DetailAccordionProps> = {}) {
    const props = buildDetailAccordionProps(overrides)
    render(<DetailAccordion {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
