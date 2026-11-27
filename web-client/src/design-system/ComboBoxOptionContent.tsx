import { type ComboBoxItem } from './ComboBoxItem.ts'
import { Icon } from './Icon.tsx'

// What a combobox option shows (inside an fm-combo__opt): a check when selected, the name with the
// part that matches what was typed in bold, and what tells it apart from others with that name.
export function ComboBoxOptionContent({
  item,
  query,
  isSelected,
}: {
  item: ComboBoxItem
  query: string
  isSelected?: boolean
}) {
  const { name, description, meta } = item
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1
  return (
    <>
      <span className="ck">{isSelected && <Icon name="check" size="sm" />}</span>
      <b>
        {at < 0 ? (
          name
        ) : (
          <>
            {name.slice(0, at)}
            <mark>{name.slice(at, at + query.length)}</mark>
            {name.slice(at + query.length)}
          </>
        )}
      </b>
      {description && <small>{description}</small>}
      {meta && <span className="r">{meta}</span>}
    </>
  )
}
