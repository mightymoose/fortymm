import { render, screen, type Container } from '@/test/utilities'

import { SettingRow, type SettingRowProps } from './setting-row'
import { buildSettingRowProps } from './setting-row.factory'

const scoped = (container: Container) => ({
  /** The row itself — a `region` named by the setting it holds. */
  getRow() {
    return container.getByRole('region')
  },
  /** The setting's name. */
  getName() {
    return container.getByTestId('draw-setting-name')
  },
  /** The one line under the name. */
  getHint() {
    return container.getByTestId('draw-setting-hint')
  },
  /** The value as the director reads it — a figure, or Membership's phrase. */
  getValue() {
    return container.getByTestId('draw-setting-value')
  },
  /** The plain words after the value. **Absent on a `phrase` row**: Membership's
   * value is already a sentence, so there is nothing to unit. */
  queryUnit() {
    return container.queryByTestId('draw-setting-unit')
  },
  /** The ownership badge — `Automatic` or `Yours`. Read as TEXT: a colour-only
   * signal would be no signal at all to a screen reader (ADR 20260808). */
  getOwnershipBadge() {
    return container.getByTestId('draw-setting-ownership')
  },
  /** The line saying where the value came from. */
  getSource() {
    return container.getByTestId('draw-setting-source')
  },
})

/** Test page-object for `SettingRow`. Composed by `drawStructureSectionPage`, which
 * scopes these accessors to one row at a time. */
export const settingRowPage = {
  render(overrides: Partial<SettingRowProps> = {}) {
    render(<SettingRow {...buildSettingRowProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
