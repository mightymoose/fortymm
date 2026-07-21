import userEvent from '@testing-library/user-event'

import { render, screen, type Container } from '@/test/utilities'

import { TimezoneSelect, type TimezoneSelectProps } from './timezone-select'
import { buildTimezoneSelectProps } from './timezone-select.factory'

const scoped = (container: Container) => ({
  /** The combobox trigger, by its accessible name — the same role the editor's
   * other selects expose (`OptionSelect`). */
  getTrigger(ariaLabel = 'Timezone') {
    return container.getByRole('combobox', { name: ariaLabel })
  },
})

/** Test page-object for `TimezoneSelect`. The `Popover` + `Command` listbox portals
 * to the body, so the search box and options resolve against `screen`. */
export const timezoneSelectPage = {
  render(overrides: Partial<TimezoneSelectProps> = {}) {
    render(<TimezoneSelect {...buildTimezoneSelectProps(overrides)} />)
  },

  /** Open the popover, filter to `query`, and pick the option whose text is
   * `zone`. Mirrors the director's actual gesture — click, type, click. */
  async pick(zone: string, query = zone) {
    const user = userEvent.setup()
    await user.click(this.getTrigger())
    const search = await screen.findByPlaceholderText('Search timezones…')
    await user.type(search, query)
    await user.click(await screen.findByRole('option', { name: zone }))
  },

  getSearch() {
    return screen.getByPlaceholderText('Search timezones…')
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
