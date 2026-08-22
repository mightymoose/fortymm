import { sectionHeaderPage } from './section-header.page'

describe('SectionHeader', () => {
  it('renders the title and subtitle', () => {
    sectionHeaderPage.render({ title: 'Reservations', subtitle: 'Reserve tables' })
    expect(sectionHeaderPage.getTitle('Reservations')).toBeInTheDocument()
    expect(sectionHeaderPage.getTitle('Reserve tables')).toBeInTheDocument()
  })
})
