import { pageTitlePage } from './page-title.page'

describe('PageTitle', () => {
  it('greets the user in the heading', async () => {
    pageTitlePage.render({ greeting: 'Hi, @rita.kovac' })

    expect(await pageTitlePage.findHeading(/Hi, @rita\.kovac/)).toBeInTheDocument()
  })

  it('renders the subtitle when one is given', async () => {
    pageTitlePage.render({ subtitle: 'Two matches to score' })

    await pageTitlePage.findHeading(/Hi/)
    expect(pageTitlePage.querySubtitle('Two matches to score')).toBeInTheDocument()
  })

  it('omits the subtitle when none is given', async () => {
    pageTitlePage.render({ subtitle: undefined })

    await pageTitlePage.findHeading(/Hi/)
    expect(pageTitlePage.querySubtitle('Two matches to score')).toBeNull()
  })

  it('renders a placeholder bar instead of the greeting while loading', async () => {
    pageTitlePage.render({ greeting: 'Hi, @rita.kovac', loading: true })

    expect(await pageTitlePage.findHeading(/loading greeting/i)).toBeInTheDocument()
    expect(pageTitlePage.querySubtitle(/rita\.kovac/)).toBeNull()
  })

  it('shows the greeting and no placeholder once loaded', async () => {
    pageTitlePage.render({ greeting: 'Hi, @rita.kovac', loading: false })

    await pageTitlePage.findHeading(/Hi, @rita\.kovac/)
    expect(pageTitlePage.queryGreetingSkeleton()).toBeNull()
  })

  it('links the "Log a match" action to /matches/new', async () => {
    pageTitlePage.render()

    await pageTitlePage.findHeading(/Hi/)
    expect(pageTitlePage.getLogMatchLink()).toHaveAttribute('href', '/matches/new')
  })
})
