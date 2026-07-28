import type {
  DetailAccordionItem,
  DetailAccordionProps,
} from './detail-accordion'

/** One explained line. */
export function buildDetailAccordionItem(
  overrides: Partial<DetailAccordionItem> = {},
): DetailAccordionItem {
  return { term: 'Matches', detail: 'start a match, enter scores', ...overrides }
}

/** Props for `DetailAccordion` — a two-line disclosure. */
export function buildDetailAccordionProps(
  overrides: Partial<DetailAccordionProps> = {},
): DetailAccordionProps {
  return {
    title: 'Capabilities and security',
    items: [
      buildDetailAccordionItem(),
      buildDetailAccordionItem({
        term: 'Players',
        detail: 'search by name or club',
      }),
    ],
    ...overrides,
  }
}
