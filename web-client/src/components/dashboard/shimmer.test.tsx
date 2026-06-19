import { shimmerPage } from './shimmer.page'

describe('Shimmer', () => {
  it('pulses and hides itself from assistive tech', () => {
    shimmerPage.render()

    const bar = shimmerPage.getShimmer()
    expect(bar).toHaveClass('animate-pulse')
    expect(bar).toHaveAttribute('aria-hidden', 'true')
  })

  it('applies the given dimensions and radius', () => {
    shimmerPage.render({ width: 80, height: 16, radius: 8 })

    expect(shimmerPage.getShimmer()).toHaveStyle({
      width: '80px',
      height: '16px',
      borderRadius: '8px',
    })
  })

  it('fills its container when no width is given', () => {
    shimmerPage.render({ width: undefined, height: 12 })

    expect(shimmerPage.getShimmer()).toHaveStyle({ width: '100%' })
  })
})
