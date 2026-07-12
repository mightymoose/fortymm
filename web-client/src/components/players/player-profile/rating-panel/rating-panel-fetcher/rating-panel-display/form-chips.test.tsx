import { buildFormChipsView } from './form-chips.factory'
import { formChipsPage } from './form-chips.page'

describe('FormChips', () => {
  it('renders one chip per result — ten of them on the profile', () => {
    formChipsPage.render({ form: buildFormChipsView() })

    expect(formChipsPage.getChips()).toHaveLength(10)
  })

  it('renders the results newest-first, as they arrive', () => {
    formChipsPage.render({
      form: buildFormChipsView({ results: ['W', 'L', 'W'] }),
    })

    expect(
      formChipsPage.getChips().map((chip) => chip.textContent),
    ).toEqual(['W', 'L', 'W'])
  })

  it('announces exactly the results it renders', () => {
    formChipsPage.render({
      form: buildFormChipsView({ results: ['W', 'L', 'W'] }),
    })

    expect(formChipsPage.getForm()).toHaveAttribute(
      'aria-label',
      'Last 3: W L W',
    )
  })
})
