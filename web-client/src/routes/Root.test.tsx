import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOADING_SCREEN_MS } from '../router'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'

describe('Root', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the design system page at once, with no loading screen', async () => {
    const designSystemPage = await DesignSystemPage.render({
      loadingScreenMs: LOADING_SCREEN_MS,
    })

    expect(designSystemPage.loadingScreen).not.toBeInTheDocument()
    expect(designSystemPage.title).toHaveTextContent('Design System')
  })
})
