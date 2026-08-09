import { pillPage } from './pill.page'

describe('Pill', () => {
  it('renders its children', () => {
    pillPage.render({ children: 'LIVE' })

    expect(pillPage.getText('LIVE')).toBeInTheDocument()
  })

  it('paints the win tone in the serve-500 ink over a green tint', () => {
    pillPage.render({ children: 'WON', tone: 'win' })

    expect(pillPage.getText('WON')).toHaveStyle({
      color: 'var(--serve-500)',
      background: 'rgba(0,226,154,0.12)',
    })
  })

  it('paints the loss tone in the loss ink over a red tint', () => {
    pillPage.render({ children: 'LOST', tone: 'loss' })

    expect(pillPage.getText('LOST')).toHaveStyle({
      color: 'var(--loss)',
      background: 'rgba(255,77,109,0.12)',
    })
  })

  it('defaults to the chalk-300 ink over a transparent background', () => {
    pillPage.render({ children: 'BO5' })

    expect(pillPage.getText('BO5')).toHaveStyle({
      color: 'var(--chalk-300)',
      background: 'transparent',
    })
  })

  // Tracking is read off the declared style, not `toHaveStyle`. jsdom 30
  // resolves `em` against the font size in computed style, so 0.08em at 11px
  // reads back as `0.88px`. Asserting that product would pin arithmetic and
  // lose the design intent, which is relative tracking.
  it('renders non-mono in the UI face, uppercased', () => {
    pillPage.render({ children: 'BO5' })

    const pill = pillPage.getText('BO5')
    expect(pill).toHaveStyle({ textTransform: 'uppercase' })
    expect(pill.style.letterSpacing).toBe('0.08em')
  })

  it('renders the mono variant in the monospace face without uppercasing', () => {
    pillPage.render({ children: '21-19', mono: true })

    const pill = pillPage.getText('21-19')
    expect(pill).toHaveStyle({ textTransform: 'none' })
    expect(pill.style.letterSpacing).toBe('0.04em')
  })
})
