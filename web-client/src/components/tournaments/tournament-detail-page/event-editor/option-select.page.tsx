import { render, screen, type Container } from '@/test/utilities'

import { OptionSelect, type OptionSelectProps } from './option-select'
import { buildOptionSelectProps } from './option-select.factory'

const scoped = (container: Container) => ({
  getTrigger(ariaLabel: string) {
    return container.getByRole('combobox', { name: ariaLabel })
  },
})

/** Test page-object for `OptionSelect`. The radix listbox portals to the body,
 * so option queries resolve against `screen`. */
export const optionSelectPage = {
  render(overrides: Partial<OptionSelectProps> = {}) {
    render(<OptionSelect {...buildOptionSelectProps(overrides)} />)
  },
  getOption(label: string) {
    return screen.getByRole('option', { name: label })
  },
  within(container: Container = screen) {
    return scoped(container)
  },
  ...scoped(screen),
}
