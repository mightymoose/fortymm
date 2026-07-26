import { championBannerPage as page } from './champion-banner.page'

describe('ChampionBanner', () => {
  it('names the champion under the callout, carrying the panel’s test id', () => {
    // The two differences between the finishes and standings callouts — the name and the
    // test id — are exactly what the panel passes in; the banner renders both.
    page.render({ name: 'player.7', testId: 'finishes-champion-ev-1' })

    const banner = page.queryBanner('finishes-champion-ev-1')
    expect(banner).not.toBeNull()
    expect(banner).toHaveTextContent('Champion')
    expect(banner).toHaveTextContent('player.7')
  })

  it('renders no interactive controls — it is a fact, not an affordance', () => {
    page.render({ testId: 'standings-champion-ev-1' })

    expect(page.getControls('standings-champion-ev-1')).toHaveLength(0)
  })
})
