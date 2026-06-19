import { statPage } from './stat.page'

describe('Stat', () => {
  it('renders its label as an overline caption', () => {
    statPage.render({ label: 'Peak', value: 1531 })

    expect(statPage.getLabel('Peak')).toBeInTheDocument()
  })

  it('renders its value in the monospace face', () => {
    statPage.render({ label: 'Peak', value: 1531 })

    expect(statPage.getText(String(1531))).toBeInTheDocument()
  })
})
