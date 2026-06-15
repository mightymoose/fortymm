import { sparklinePage as page } from './sparkline.page'

describe('Sparkline', () => {
  it('draws a trend line with one move plus a line per remaining point', () => {
    const spark = page.render({ data: [10, 20, 30, 40] })

    const d = spark.getTrendPath().getAttribute('d') ?? ''
    expect(d.startsWith('M')).toBe(true)
    // 4 points → 1 "M" command and 3 "L" segments.
    expect(d.match(/L/g)).toHaveLength(3)
  })

  it('closes the gradient area path back to the baseline', () => {
    const spark = page.render({ data: [10, 20, 30] })
    expect(spark.getAreaPath().getAttribute('d')?.endsWith('Z')).toBe(true)
  })

  it('renders both end-point dots', () => {
    const spark = page.render()
    expect(spark.getDots()).toHaveLength(2)
  })

  it('fills its container when fluid and uses the fixed width otherwise', () => {
    expect(page.render({ fluid: true }).getWrapper()).toHaveStyle({
      width: '100%',
    })
    expect(page.render({ fluid: false, w: 280 }).getWrapper()).toHaveStyle({
      width: '280px',
    })
  })

  it('strokes the line in the requested color', () => {
    const spark = page.render({ color: 'var(--serve-500)' })
    expect(spark.getTrendPath()).toHaveAttribute('stroke', 'var(--serve-500)')
  })
})
