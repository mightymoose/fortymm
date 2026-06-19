import { monoPage } from './mono.page'

describe('Mono', () => {
  it('renders its children as tabular-nums monospace text', () => {
    monoPage.render({ children: '1492' })

    expect(monoPage.getText('1492')).toHaveStyle({
      fontVariantNumeric: 'tabular-nums',
    })
  })

  it('defaults to the chalk-50 ink', () => {
    monoPage.render({ children: '1492' })

    expect(monoPage.getText('1492')).toHaveStyle({ color: 'var(--chalk-50)' })
  })

  it('honors an explicit color so deltas can read as a loss', () => {
    monoPage.render({ children: '-12', color: 'var(--loss)' })

    expect(monoPage.getText('-12')).toHaveStyle({ color: 'var(--loss)' })
  })
})
