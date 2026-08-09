import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { SettingRow, type SettingRowProps } from './setting-row'
import { buildSettingRowProps } from './setting-row.factory'

const scoped = (container: Container) => ({
  /** The row itself — a `region` named by the setting it holds.
   *
   * ⚠️ Only available at *screen* scope: a container already scoped **to** the region
   * cannot then find it, since a `within` query searches descendants. The section's page
   * object scopes each row this way, so it sweeps the whole tab instead. */
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
  /** The value as the director reads it — a figure, or Membership's phrase. **Absent
   * when the director owns the setting and may edit it**: the box is the value then, and
   * a row that showed both would be showing one number twice. */
  getValue() {
    return container.getByTestId('draw-setting-value')
  },
  queryValue() {
    return container.queryByTestId('draw-setting-value')
  },
  /** The direct-entry box, when the director owns this setting. `<input type="text"
   * inputMode="numeric">` — there is no spinner and there are no plus/minus buttons. */
  getInput() {
    return container.getByTestId('draw-setting-input')
  },
  queryInput() {
    return container.queryByTestId('draw-setting-input')
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
  /** The one quiet text action — `Set myself` / `Use automatic`, or Membership's
   * `Assign myself` / `Use snake`. Absent for a reader. */
  getAction() {
    return container.getByTestId('draw-setting-action')
  },
  queryAction() {
    return container.queryByTestId('draw-setting-action')
  },
  /** The extra line under the source, for a consequence the setting carries. Absent on
   * every row but a hand-dealt Membership. */
  queryNote() {
    return container.queryByTestId('draw-setting-note')
  },
  /** The resolver's red for this row's value. Distinct test id from the freeze reason
   * below, even though the two share one slot, so a test cannot pass on a freeze rendered
   * where an error belongs. */
  queryError() {
    return container.queryByTestId('draw-setting-error')
  },
  /** The reason this row is frozen — a cut draw's refusal, in words (ADR 20260806). */
  queryFreezeReason() {
    return container.queryByTestId('draw-setting-freeze')
  },
  /** Whatever the box or the action POINTS at (`aria-describedby`), resolved to the node
   * itself. A disabled control is not focusable and carries no tooltip, so this is the
   * only channel its reason has left — and asserting the text sits *somewhere* on the row
   * would pass on a reason nothing points at (#1223, the bug in the frozen draw-type
   * select). `null` when the control describes nothing. */
  describedNodeOf(control: HTMLElement) {
    const id = control.getAttribute('aria-describedby')
    return id === null ? null : document.getElementById(id)
  },
  /** The row's interactive controls — the one sweep (`@/test/read-only`), composed
   * rather than re-typed. Screen scope only, for the reason `getRow` gives; the tab's
   * own guard sweeps the whole tab (`drawStructureSectionPage.getFormElements`). */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('draw-setting-row'))
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
