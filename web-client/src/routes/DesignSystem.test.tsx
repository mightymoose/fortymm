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

  it('has a Button card in the Forms & Input section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.buttonCardHeading).toHaveTextContent('Button')
    expect(designSystemPage.buttonCard).toHaveTextContent(
      '7 variants · 4 sizes',
    )
  })

  it.each([
    'Log a match',
    'Save draft',
    'Cancel',
    'Skip',
    'Forfeit match',
    'Read manifesto',
    'Small',
    'Default',
    'Large',
    'Add',
  ])('shows an enabled %s button', async (name) => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.button(name)).toBeEnabled()
  })

  it('shows a disabled button', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.button('Disabled')).toBeDisabled()
  })
})
