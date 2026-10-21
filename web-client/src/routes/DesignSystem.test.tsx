import { describe, expect, it } from 'vitest'
import { DesignSystemPage } from '../test/pages/DesignSystemPage'

describe('DesignSystem', () => {
  it('shows the Design System title', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.title).toHaveTextContent('Design System')
  })

  it('introduces the design system under the header', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.intro).toHaveTextContent(
      /^Every FortyMM component, styled with the design system's tokens\./,
    )
  })

  it('has a Forms & Input section with a lead line', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.formsSectionHeading).toHaveTextContent(
      'Forms & Input',
    )
    expect(designSystemPage.formsSectionLead).toHaveTextContent(
      /^Buttons, inputs, selectors\./,
    )
  })
})
