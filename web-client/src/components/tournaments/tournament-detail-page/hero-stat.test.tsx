import { heroStatPage } from './hero-stat.page'

describe('HeroStat', () => {
  it('renders the value, label, and optional suffix', () => {
    heroStatPage.render({ label: 'Days', value: 2, suffix: 'days' })
    expect(heroStatPage.getByLabel('Days')).toBeInTheDocument()
    expect(document.body).toHaveTextContent('2')
    expect(document.body).toHaveTextContent('days')
  })
})
