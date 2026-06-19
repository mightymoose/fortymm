import { attentionPanelSkeletonPage } from './attention-panel-skeleton.page'

describe('AttentionPanelSkeleton', () => {
  it('announces the load through a busy status region', () => {
    attentionPanelSkeletonPage.render()

    expect(attentionPanelSkeletonPage.getStatus()).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  // No-layout-shift contract: a heading bar, two action rows (avatar +
  // headline + button each), and a footer line = 8 reserved shimmer bars.
  it('reserves the heading, two action rows, and a footer', () => {
    attentionPanelSkeletonPage.render()

    expect(attentionPanelSkeletonPage.getAllShimmers()).toHaveLength(8)
  })
})
