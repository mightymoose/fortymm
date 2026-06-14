import { sectionHeaderPage } from './section-header.page'

describe('SectionHeader', () => {
  it('renders the title and subtitle', () => {
    sectionHeaderPage.render({ title: 'Table pools', subtitle: 'Reserve tables' })
    expect(sectionHeaderPage.getTitle('Table pools')).toBeInTheDocument()
    expect(sectionHeaderPage.getTitle('Reserve tables')).toBeInTheDocument()
  })
})
