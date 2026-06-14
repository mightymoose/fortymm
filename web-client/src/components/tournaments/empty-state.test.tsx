import { emptyStatePage } from './empty-state.page'

describe('EmptyState', () => {
  it('renders the title and hint', () => {
    emptyStatePage.render({ title: 'No pools yet', hint: 'Add a pool to start.' })
    expect(emptyStatePage.queryTitle('No pools yet')).toBeInTheDocument()
    expect(emptyStatePage.queryHint('Add a pool to start.')).toBeInTheDocument()
  })

  it('renders an action when provided', () => {
    emptyStatePage.render({ title: 'Empty', action: <button>Add</button> })
    expect(emptyStatePage.queryTitle('Add')).toBeInTheDocument()
  })
})
