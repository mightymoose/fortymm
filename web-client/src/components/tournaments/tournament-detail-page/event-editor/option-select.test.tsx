import { optionSelectPage } from './option-select.page'

describe('OptionSelect', () => {
  it('renders the selected option label on the trigger', () => {
    optionSelectPage.render({ value: 'doubles', ariaLabel: 'Format' })
    expect(optionSelectPage.getTrigger('Format')).toHaveTextContent('Doubles')
  })

  it('exposes the trigger by its accessible name', () => {
    optionSelectPage.render({ ariaLabel: 'Draw type' })
    expect(optionSelectPage.getTrigger('Draw type')).toBeInTheDocument()
  })
})
