import { buildDashboardHeaderView } from './dashboard-header.factory'
import { dashboardHeaderPage as page } from './dashboard-header.page'

describe('DashboardHeader', () => {
  it('renders the greeting headline from the view', async () => {
    page.render({ view: buildDashboardHeaderView({ greeting: 'Hi, @nguyen.t' }) })

    const heading = await page.findGreeting()
    expect(heading).toHaveTextContent('Hi, @nguyen.t')
  })

  it('links the "Log a match" action to the new-match route', async () => {
    page.render()

    await page.findGreeting()
    expect(page.getLogMatchLink()).toHaveAttribute('href', '/matches/new')
  })
})
