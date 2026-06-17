import userEvent from '@testing-library/user-event'
import { render, screen, type Container } from '@/test/utilities'
import { PreferencesView, type PreferencesViewProps } from './preferences-view'
import { buildPreferencesViewProps } from './preferences-view.factory'

const scoped = (container: Container) => ({
  getHeading() {
    return container.getByRole('heading', { name: 'NOTIFICATIONS' })
  },
  /** A channel "sign-up" master switch, by channel label (In-app/Push/...). */
  channelSwitch(label: string) {
    return container.getByRole('switch', { name: `${label} notifications` })
  },
  /** A matrix cell checkbox, by category + channel label. */
  cell(categoryLabel: string, channelLabel: string) {
    return container.getByRole('checkbox', {
      name: `${categoryLabel} via ${channelLabel}`,
    })
  },
  queryText(text: string) {
    return container.queryByText(text)
  },
})

export const preferencesViewPage = {
  render(overrides: Partial<PreferencesViewProps> = {}) {
    render(<PreferencesView {...buildPreferencesViewProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  async toggleChannel(label: string) {
    await userEvent.click(this.channelSwitch(label))
  },
  async toggleCell(categoryLabel: string, channelLabel: string) {
    await userEvent.click(this.cell(categoryLabel, channelLabel))
  },

  ...scoped(screen),
}
