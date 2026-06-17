import { render, screen, type Container } from '@/test/utilities'

import { TablesTab, type TablesTabProps } from './tables-tab'
import { buildTablesTabProps } from './tables-tab.factory'

const scoped = (container: Container) => ({
  getRemoveButton(label: string) {
    return container.getByRole('button', { name: `Remove ${label}` })
  },
  /** A table's Remove button — absent for a non-creator (`canEdit: false`). */
  queryRemoveButton(label: string) {
    return container.queryByRole('button', { name: `Remove ${label}` })
  },
  getLabelInput() {
    return container.getByRole('textbox', { name: 'Table label' })
  },
  getCourtInput() {
    return container.getByRole('textbox', { name: 'Court' })
  },
  getAddButton() {
    return container.getByRole('button', { name: 'Add table' })
  },
  /** The add-table submit button — absent for a non-creator (`canEdit: false`),
   * along with the rest of the add-table form. */
  queryAddButton() {
    return container.queryByRole('button', { name: 'Add table' })
  },
})

/** Test page-object for `TablesTab`. */
export const tablesTabPage = {
  render(overrides: Partial<TablesTabProps> = {}) {
    render(<TablesTab {...buildTablesTabProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
