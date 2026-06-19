import { sectionHeaderPage } from './section-header.page'

describe('SectionHeader', () => {
  it('renders the title as a heading', async () => {
    sectionHeaderPage.render({ title: 'Recent matches' })

    expect(await sectionHeaderPage.findHeading('Recent matches')).toBeVisible()
  })

  it('shows the subtitle when one is given', async () => {
    sectionHeaderPage.render({ title: 'Your game', subtitle: 'Last 30 days' })

    await sectionHeaderPage.findHeading('Your game')
    expect(sectionHeaderPage.querySubtitle('Last 30 days')).toBeVisible()
  })

  it('renders the action as a link to actionTo, with the action label and search applied', async () => {
    sectionHeaderPage.render({
      title: 'Your game',
      action: 'View all',
      actionTo: '/matches',
      actionSearch: { status: 'attention' },
    })

    const link = await sectionHeaderPage.findActionLink('View all')
    expect(link).toHaveAttribute('href', '/matches?status=attention')
  })

  it('omits the link when no action is given', async () => {
    sectionHeaderPage.render({ title: 'Your game' })

    await sectionHeaderPage.findHeading('Your game')
    expect(sectionHeaderPage.queryActionLink()).toBeNull()
  })

  it('omits the link when an action label has no target route', async () => {
    sectionHeaderPage.render({ title: 'Your game', action: 'View all' })

    await sectionHeaderPage.findHeading('Your game')
    expect(sectionHeaderPage.queryActionLink()).toBeNull()
  })
})
