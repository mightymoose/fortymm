import { boardEmptyPage as page } from './board-empty.page'

describe('BoardEmpty', () => {
  it('prompts the owner to run the scheduler', () => {
    page.render({ canEdit: true })
    expect(page.getEmpty()).toHaveTextContent('No matches placed yet')
    expect(page.getEmpty()).toHaveTextContent(
      'Run the scheduler to place every match on a table',
    )
  })

  it('gives a viewer the fact, not the instruction', () => {
    page.render({ canEdit: false })
    expect(page.getEmpty()).toHaveTextContent(
      'The organizer has not placed any matches yet.',
    )
    expect(page.getEmpty()).not.toHaveTextContent('Run the scheduler')
  })
})
