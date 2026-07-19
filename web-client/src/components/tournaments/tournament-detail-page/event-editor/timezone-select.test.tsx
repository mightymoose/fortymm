import userEvent from '@testing-library/user-event'

import { screen } from '@/test/utilities'

import { ianaTimezones } from './iana-timezones'
import { TimezoneSelect } from './timezone-select'
import { timezoneSelectPage } from './timezone-select.page'

describe('TimezoneSelect', () => {
  it('shows the selected zone on the trigger', () => {
    timezoneSelectPage.render({ value: 'America/Denver' })
    expect(timezoneSelectPage.getTrigger()).toHaveTextContent('America/Denver')
  })

  it('exposes the trigger by its accessible name', () => {
    timezoneSelectPage.render({ ariaLabel: 'Event timezone' })
    expect(
      timezoneSelectPage.getTrigger('Event timezone'),
    ).toBeInTheDocument()
  })

  it('picks a searched zone and hands back the exact IANA name', async () => {
    const onChange = vi.fn()
    timezoneSelectPage.render({ value: 'America/Chicago', onChange })
    await timezoneSelectPage.pick('America/Denver', 'Denver')
    // Exact casing — cmdk lowercases its callback arg, so the component closes over
    // the real name; a `america/denver` here would be a 422 on the server.
    expect(onChange).toHaveBeenCalledWith('America/Denver')
  })

  it('filters the list as the director types', async () => {
    const user = userEvent.setup()
    timezoneSelectPage.render({ value: 'UTC' })
    await user.click(timezoneSelectPage.getTrigger())
    await user.type(timezoneSelectPage.getSearch(), 'Tokyo')
    expect(
      await screen.findByRole('option', { name: 'Asia/Tokyo' }),
    ).toBeInTheDocument()
  })
})

describe('ianaTimezones', () => {
  it('lists many real IANA zones from the runtime', () => {
    const zones = ianaTimezones()
    expect(zones).toContain('America/Chicago')
    expect(zones).toContain('Europe/Paris')
    // The runtime's full set is hundreds of zones — far more than the fallback.
    expect(zones.length).toBeGreaterThan(50)
  })

  it('folds a current zone the runtime does not list to the front', () => {
    const zones = ianaTimezones('Fictional/Zone')
    expect(zones[0]).toBe('Fictional/Zone')
  })

  it('is a real component export', () => {
    expect(TimezoneSelect).toBeTypeOf('function')
  })
})
