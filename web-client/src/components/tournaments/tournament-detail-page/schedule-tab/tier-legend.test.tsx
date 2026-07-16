import { tierLegendPage as page } from './tier-legend.page'

describe('TierLegend', () => {
  it('names all three tiers in words, not swatches alone', () => {
    page.render()
    const legend = page.getLegend()
    expect(legend).toHaveTextContent('Estimate — may move')
    expect(legend).toHaveTextContent('Called — players notified')
    expect(legend).toHaveTextContent('In play or finished')
  })
})
