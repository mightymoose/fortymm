import { buttonPage } from './button.page'

describe('Button', () => {
  it('renders a Link to the `to` target carrying the label', async () => {
    buttonPage.render({ children: 'Log a match', to: '/matches/new' })

    const link = await buttonPage.findLink('Log a match')
    expect(link).toHaveAttribute('href', '/matches/new')
  })

  it('renders a plain type="button" element when `to` is omitted', async () => {
    buttonPage.render({ children: 'Log a match', to: undefined })

    const button = await buttonPage.findButton('Log a match')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
  })

  it('paints the primary kind with the ball-500 fill on ink-950 text', async () => {
    buttonPage.render({ kind: 'primary' })

    const link = await buttonPage.findLink('Log a match')
    expect(link).toHaveStyle({
      background: 'var(--ball-500)',
      color: 'var(--ink-950)',
    })
    expect(link.style.border).toBe('1px solid transparent')
  })

  it('paints the secondary kind as a bordered transparent chip', async () => {
    buttonPage.render({ kind: 'secondary' })

    const link = await buttonPage.findLink('Log a match')
    expect(link).toHaveStyle({
      background: 'transparent',
      color: 'var(--chalk-100)',
    })
    expect(link.style.border).toBe('1px solid var(--ink-500)')
  })

  it('renders a small button at 32px tall', async () => {
    buttonPage.render({ size: 'sm' })
    expect(await buttonPage.findLink('Log a match')).toHaveStyle({
      height: '32px',
    })
  })

  it('renders a large button at 52px tall', async () => {
    buttonPage.render({ size: 'lg' })
    expect(await buttonPage.findLink('Log a match')).toHaveStyle({
      height: '52px',
    })
  })
})
