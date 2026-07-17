import { tierLegendPage as page } from './tier-legend.page'

describe('TierLegend', () => {
  it('names all three tiers in words, not swatches alone', () => {
    page.render()
    const legend = page.getLegend()
    expect(legend).toHaveTextContent('Estimate — may move')
    expect(legend).toHaveTextContent('Called / pinned — a fixed time')
    // Not "in play": a materialized (`in_progress`) match may be hours from
    // its table — the legend must not promise live play either.
    expect(legend).toHaveTextContent('Underway, up next, or finished')
  })
})
