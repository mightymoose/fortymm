import { useId } from 'react'
import { type ComboBoxItem } from '../../design-system/ComboBoxItem.ts'
import { ComboBoxOptionContent } from '../../design-system/ComboBoxOptionContent.tsx'
import { Icon } from '../../design-system/Icon.tsx'

// A combobox drawn open in place, for the showcase boards: a ComboBox's look with `query` typed,
// focused, its matches listed and the first one highlighted, but not wired up. A real ComboBox
// can't be held open on a page: while open, it hides the rest of the page from assistive
// technology. Not for app screens.
export function StaticComboBox({
  label,
  listLabel,
  items,
  query,
}: {
  label: string
  listLabel: string
  items: readonly ComboBoxItem[]
  query: string
}) {
  const inputId = useId()
  const listId = useId()
  const matches = items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="fm-field">
      <label className="fm-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="fm-combo">
        <Icon name="search" />
        <input
          id={inputId}
          className="fm-input is-focus"
          defaultValue={query}
          readOnly
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
        />
        <ul className="fm-combo__list fm-overlay" id={listId} role="listbox" aria-label={listLabel}>
          {matches.map((item, index) => (
            <li key={item.id} className="fm-combo__opt" role="option" aria-selected={index === 0}>
              <ComboBoxOptionContent item={item} query={query} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
