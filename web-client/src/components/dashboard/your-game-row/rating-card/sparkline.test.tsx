import { sparklinePage } from './sparkline.page'

describe('Sparkline', () => {
  it('draws the trend line through every data point', () => {
    sparklinePage.render({ data: [1480, 1465, 1490, 1510] })

    // One M plus an L per remaining point (3 here).
    expect(sparklinePage.getTrendLine().getAttribute('d')).toMatch(
      /^M[\d. ]+(L[\d. ]+){3}$/,
    )
  })

  it('scales the points across the padded canvas, min to bottom and max to top', () => {
    // Two points over a 280×48 canvas with 2px padding: x spans pad → w-pad,
    // the min (0) sits at the bottom and the max (10) at the top. Exact
    // coordinates pin the scaling math.
    sparklinePage.render({ data: [0, 10] })

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      'd',
      'M2.0 46.0 L278.0 2.0',
    )
  })

  it('strokes the trend line in the given color', () => {
    sparklinePage.render({ data: [1480, 1510], color: 'var(--serve-500)' })

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      'stroke',
      'var(--serve-500)',
    )
    // The trend line is unfilled; only the area path carries the gradient fill.
    expect(sparklinePage.getTrendLine()).toHaveAttribute('fill', 'none')
  })

  it('defaults to the ball-500 ink', () => {
    sparklinePage.render({ data: [1480, 1510] })

    expect(sparklinePage.getTrendLine()).toHaveAttribute(
      'stroke',
      'var(--ball-500)',
    )
  })

  it('overlays an end-point dot at the last data point', () => {
    sparklinePage.render({ data: [0, 10], color: 'var(--serve-500)' })

    const dots = sparklinePage
      .getSparkline()
      .querySelectorAll('span[aria-hidden]')
    // A faint halo plus a solid core dot.
    expect(dots).toHaveLength(2)
    const core = dots[1] as HTMLElement
    // Last point is at x=278/280 → 99.28..%, y=2/48 → 4.16..%.
    expect(core.style.left).toBe('99.28571428571429%')
    expect(core.style.top).toBe('4.166666666666666%')
    expect(core.style.background).toBe('var(--serve-500)')
  })

  it('keeps the decorative dots out of the accessibility tree', () => {
    sparklinePage.render({ data: [1480, 1510] })

    const dots = sparklinePage
      .getSparkline()
      .querySelectorAll('span[aria-hidden]')
    expect(dots).toHaveLength(2)
    dots.forEach((dot: Element) =>
      expect(dot).toHaveAttribute('aria-hidden', 'true'),
    )
  })
})
