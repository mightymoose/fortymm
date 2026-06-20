import { attentionPanelSkeletonPage } from './attention-panel-skeleton.page'

describe('AttentionPanelSkeleton', () => {
  it('announces the load through a busy status region', () => {
    attentionPanelSkeletonPage.render()

    expect(attentionPanelSkeletonPage.getStatus()).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  // Reserves only a single compact row — heading bar + one action row (avatar
  // + headline + button) = 4 shimmer bars — because the real panel is
  // conditional and a full-height skeleton would lurch the page on load.
  it('reserves a heading and a single compact action row', () => {
    attentionPanelSkeletonPage.render()

    expect(attentionPanelSkeletonPage.getAllShimmers()).toHaveLength(4)
  })
})
