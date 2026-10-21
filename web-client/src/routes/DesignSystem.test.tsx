import { describe, expect, it } from 'vitest'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'

describe('DesignSystem', () => {
  it('shows the Design System title', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.title).toHaveTextContent('Design System')
  })
})
