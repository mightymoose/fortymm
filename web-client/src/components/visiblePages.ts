// One place in a pagination row: a page's number, or a gap standing for the
// pages left out.
export type PageSlot = number | 'gap'

// The pages a pagination row shows when `page` of `pageCount` is current:
// the first and the last, and the current one with its neighbours. At either
// end, the three end pages, so the row keeps its length. A gap of one page
// shows that page, since it takes no more room than the gap would.
export function visiblePages(page: number, pageCount: number): PageSlot[] {
  const from = Math.max(1, Math.min(page - 1, pageCount - 2))
  const to = Math.min(pageCount, Math.max(page + 1, 3))
  const pages = [1]
  for (let n = Math.max(from, 2); n <= to; n++) pages.push(n)
  if (pageCount > to) pages.push(pageCount)

  const slots: PageSlot[] = []
  for (const n of pages) {
    const previous = slots.at(-1)
    if (typeof previous === 'number' && n - previous === 2) slots.push(n - 1)
    else if (typeof previous === 'number' && n - previous > 2) slots.push('gap')
    slots.push(n)
  }
  return slots
}
