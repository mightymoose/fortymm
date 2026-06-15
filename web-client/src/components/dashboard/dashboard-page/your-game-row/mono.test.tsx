import { monoPage as page } from './mono.page'

describe('Mono', () => {
  it('renders its children with the tabular monospace utility', () => {
    page.render({ children: '1612' })

    const span = page.get('1612')
    expect(span).toHaveClass('font-mono')
  })

  it('applies the size, weight, and color overrides inline', () => {
    page.render({ children: '+24', size: 12, weight: 700, color: 'var(--serve-500)' })

    const span = page.get('+24')
    expect(span).toHaveStyle({
      fontSize: '12px',
      fontWeight: '700',
      color: 'var(--serve-500)',
    })
  })
})
