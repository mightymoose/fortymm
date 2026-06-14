import { fireEvent } from '@/test/utilities'

import { buildEvent } from '../../data/seed.factory'
import { basicsSectionPage } from './basics-section.page'

describe('BasicsSection', () => {
  it('shows the event name and format', () => {
    basicsSectionPage.render({
      event: buildEvent({ name: 'Open Singles', format: 'singles' }),
    })
    expect(basicsSectionPage.getNameInput()).toHaveValue('Open Singles')
    expect(basicsSectionPage.getFormatTrigger()).toHaveTextContent('Singles')
  })

  it('emits a numeric player limit', () => {
    const onChange = vi.fn()
    basicsSectionPage.render({ event: buildEvent({ maxPlayers: 32 }), onChange })
    fireEvent.change(basicsSectionPage.getPlayerLimitInput(), {
      target: { value: '48' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ maxPlayers: 48 }),
    )
  })
})
