import { emptyStatePage } from './empty-state.page'

describe('EmptyState', () => {
  it('renders the title and hint', () => {
    emptyStatePage.render({
      title: 'No reservations yet',
      hint: 'Add a reservation to start.',
    })
    expect(emptyStatePage.queryTitle('No reservations yet')).toBeInTheDocument()
    expect(
      emptyStatePage.queryHint('Add a reservation to start.'),
    ).toBeInTheDocument()
  })

  it('renders an action when provided', () => {
    emptyStatePage.render({ title: 'Empty', action: <button>Add</button> })
    expect(emptyStatePage.queryTitle('Add')).toBeInTheDocument()
  })
})
