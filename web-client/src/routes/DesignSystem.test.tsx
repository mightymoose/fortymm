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

  it('has an Input · Label · Form Field card in the Forms & Input section', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.inputCardHeading).toHaveTextContent(
      'Input · Label · Form Field',
    )
    expect(designSystemPage.inputCard).toHaveTextContent('composite')
  })

  it('describes the Player tag input with its help text', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const input = designSystemPage.input('Player tag')
    expect(input).toHaveValue('@nguyen.t')
    expect(input).toHaveAttribute('placeholder', '@yourname')
    expect(input).toHaveAccessibleDescription(
      'Visible to opponents in match invites.',
    )
    expect(input).toBeValid()
    expect(input).not.toBeRequired()
  })

  it('shows a required, invalid Email input with an error', async () => {
    const designSystemPage = await DesignSystemPage.render()

    // The label's asterisk isn't part of the input's name.
    const input = designSystemPage.input('Email')
    expect(input).toHaveValue('not-an-email')
    expect(input).toBeRequired()
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription('Enter a valid email address.')
  })

  it('shows a disabled input', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const input = designSystemPage.input('Disabled')
    expect(input).toBeDisabled()
    expect(input).toHaveValue('Locked field')
  })

  it('shows a Search input with no description', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const input = designSystemPage.input('Search')
    expect(input).toHaveAttribute(
      'placeholder',
      'Search clubs, players, tournaments…',
    )
    expect(input).toHaveValue('')
    expect(input).not.toHaveAccessibleDescription()
  })

  it('shows the Textarea card after the Input card', async () => {
    const designSystemPage = await DesignSystemPage.render()

    expect(designSystemPage.textareaCardHeading).toHaveTextContent('Textarea')
    expect(designSystemPage.textareaCard).toHaveTextContent('resizable')
    expect(
      designSystemPage.inputCard.compareDocumentPosition(
        designSystemPage.textareaCard,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows a labelled Match notes textarea', async () => {
    const designSystemPage = await DesignSystemPage.render()

    const textarea = designSystemPage.textarea
    expect(textarea).toHaveValue(
      "Played in the back hall. Andrew's forehand was on fire today — three straight games to 11.",
    )
    expect(textarea).toHaveAttribute(
      'placeholder',
      'Add context — venue, conditions, anything memorable.',
    )
    expect(textarea).not.toHaveAccessibleDescription()
  })
})
