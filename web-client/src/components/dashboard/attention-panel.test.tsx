import { waitFor } from '@testing-library/react'
import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import {
  buildAttentionPanelView,
  buildAttentionRowView,
} from './attention-panel.factory'
import { attentionPanelPage as page } from './attention-panel.page'

describe('AttentionPanel', () => {
  it('renders each row with its headline and action button', async () => {
    page.render({
      view: buildAttentionPanelView({
        rows: [
          buildAttentionRowView({
            matchId: 'm-dispute',
            opponentName: 'congenial.wallaby',
            headline: 'vs congenial.wallaby',
            actionLabel: 'Resolve dispute',
            primary: true,
            route: matchDetailRoute('m-dispute'),
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

    const dispute = page.getRowAction('vs congenial.wallaby')
    expect(dispute).toHaveTextContent('Resolve dispute')
    expect(dispute).toHaveAttribute('href', '/matches/m-dispute')

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
