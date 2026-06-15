import { skeletonCardPage as page } from './skeleton-card.page'

describe('SkeletonCard', () => {
  it('exposes a labeled busy status with the requested height', () => {
    page.render({ label: 'Loading recent matches', height: 200 })

    const status = page.getStatus('Loading recent matches')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveStyle({ minHeight: '200px' })
  })
})
