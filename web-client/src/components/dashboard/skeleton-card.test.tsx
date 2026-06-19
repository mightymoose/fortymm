import { skeletonCardPage } from './skeleton-card.page'

describe('SkeletonCard', () => {
  it('exposes a status region named by its aria-label', () => {
    skeletonCardPage.render({ label: 'Loading rating' })

    expect(skeletonCardPage.getSkeleton('Loading rating')).toBeInTheDocument()
  })

  it('marks the status region as busy for assistive tech', () => {
    skeletonCardPage.render({ label: 'Loading rating' })

    expect(skeletonCardPage.getSkeleton('Loading rating')).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  it('applies the given height as a min-height', () => {
    skeletonCardPage.render({ label: 'Loading rating', height: 160 })

    expect(skeletonCardPage.getSkeleton('Loading rating')).toHaveStyle({
      minHeight: '160px',
    })
  })
})
