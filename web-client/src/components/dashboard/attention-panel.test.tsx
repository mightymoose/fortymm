import { waitFor } from '@testing-library/react'
import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import {
  buildAttentionPanelView,
  buildAttentionRowView,
} from './attention-panel.factory'
import { attentionPanelPage as page } from './attention-panel.page'

/**
 * The footer's visible text. Its summary spans and the "View all" link are
 * separated only by flex `gap-x-2` (no literal whitespace in the DOM), so
 * `textContent` would jam them together; join the direct children's text with
 * a single space to reflect what the user actually reads.
 */
function footerText(p: typeof page) {
  const footer = p.getViewAllLink().closest('div')!
  return Array.from<Element>(footer.children)
    .map((child) => child.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
    .join(' ')
}

describe('AttentionPanel', () => {
  it('renders each row with its headline and action button', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [
          buildAttentionRowView({
            matchId: 'm-review',
            opponentName: 'congenial.wallaby',
            headline: 'vs congenial.wallaby',
            actionLabel: 'Review result',
            primary: true,
            route: matchDetailRoute('m-review'),
          }),
          buildAttentionRowView({
            matchId: 'm-score',
            headline: 'vs nguyen.t',
            actionLabel: 'Enter score',
            primary: false,
            route: scoringNewRoute('m-score', 2),
          }),
        ],
      }),
    })

    await page.findPanel()
    expect(page.getRows()).toHaveLength(2)

    const review = page.getRowAction('vs congenial.wallaby')
    expect(review).toHaveTextContent('Review result')
    expect(review).toHaveAttribute('href', '/matches/m-review')

    const score = page.getRowAction('vs nguyen.t')
    expect(score).toHaveTextContent('Enter score')
    expect(score).toHaveAttribute(
      'href',
      '/matches/m-score/games/2/scores/new',
    )
  })

  it('hides entirely when there is nothing to surface', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [],
        overflowCount: 0,
        waitingCount: 0,
      }),
    })

    await waitFor(() => expect(page.queryPanel()).not.toBeInTheDocument())
  })

  it('hides even when matches are waiting but there is nothing to act on', async () => {
    // Purely a to-do list — "N waiting on others" never keeps it on screen
    // when the user has no actionable rows.
    page.render({
      view: buildAttentionPanelView({ rows: [], waitingCount: 2 }),
    })

    await waitFor(() => expect(page.queryPanel()).not.toBeInTheDocument())
  })

  it('summarizes overflow and waiting counts in the footer', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [buildAttentionRowView()],
        overflowCount: 3,
        waitingCount: 2,
      }),
    })

    await page.findPanel()
    expect(page.queryFooterText(/3 more need attention/)).toBeInTheDocument()
    expect(page.queryFooterText(/2 waiting on others/)).toBeInTheDocument()
  })

  it('does not leave a trailing separator before "View all" (waiting only)', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [buildAttentionRowView()],
        overflowCount: 0,
        waitingCount: 3,
      }),
    })

    await page.findPanel()
    // No separator dot may sit between the summary and the "View all" link.
    expect(footerText(page)).toBe('3 waiting on others View all')
  })

  it('does not leave a trailing separator before "View all" (overflow only)', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [buildAttentionRowView()],
        overflowCount: 2,
        waitingCount: 0,
      }),
    })

    await page.findPanel()
    expect(footerText(page)).toBe('2 more need attention View all')
  })

  it('joins overflow and waiting with a single separator, none before "View all"', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [buildAttentionRowView()],
        overflowCount: 2,
        waitingCount: 3,
      }),
    })

    await page.findPanel()
    expect(footerText(page)).toBe(
      '2 more need attention · 3 waiting on others View all',
    )
  })

  it('uses the singular verb for a single overflow item', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [buildAttentionRowView()],
        overflowCount: 1,
      }),
    })

    await page.findPanel()
    expect(page.queryFooterText(/1 more needs attention/)).toBeInTheDocument()
    expect(page.queryFooterText(/need attention/)).not.toBeInTheDocument()
  })

  it('links "View all" to the matches Attention tab', async () => {
    page.render({
      view: buildAttentionPanelView({ viewAllSearch: { status: 'attention' } }),
    })

    await page.findPanel()
    expect(page.getViewAllLink()).toHaveAttribute(
      'href',
      '/matches?status=attention',
    )
  })
})
