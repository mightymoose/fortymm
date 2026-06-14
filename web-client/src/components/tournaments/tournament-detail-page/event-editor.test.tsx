import userEvent from '@testing-library/user-event'

import { screen } from '@/test/utilities'

import { buildEvent } from '../data/seed.factory'
import { eventEditorPage } from './event-editor.page'

describe('EventEditor', () => {
  it('saves the working draft', async () => {
    const onSave = vi.fn()
    eventEditorPage.render({ event: buildEvent({ name: 'Open Singles' }), onSave })

    await userEvent.click(eventEditorPage.getSaveButton())
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Open Singles' }),
    )
  })

  it('offers delete only for an existing event', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'ev-1' }) })
    expect(eventEditorPage.queryDeleteButton()).toBeInTheDocument()
    expect(eventEditorPage.getSaveButton()).toHaveTextContent('Save changes')
  })

  it('labels a new event and hides delete', () => {
    eventEditorPage.render({ event: buildEvent({ id: 'new-123' }) })
    expect(eventEditorPage.queryDeleteButton()).toBeNull()
    expect(eventEditorPage.getSaveButton()).toHaveTextContent('Create event')
  })

  it('switches sections via the tabs', async () => {
    eventEditorPage.render({ event: buildEvent() })
    await userEvent.click(eventEditorPage.getSectionTab('Match settings'))
    expect(screen.getByRole('switch', { name: 'Rated' })).toBeInTheDocument()
  })
})
