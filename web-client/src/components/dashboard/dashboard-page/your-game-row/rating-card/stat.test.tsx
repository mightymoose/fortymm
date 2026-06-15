import { statPage as page } from './stat.page'

describe('Stat', () => {
  it('renders the label and value', () => {
    page.render({ label: 'RD', value: '142' })

    expect(page.getLabel('RD')).toBeInTheDocument()
    expect(page.getValue('142')).toBeInTheDocument()
  })
})
