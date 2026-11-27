import { useRef } from 'react'
import { useOption } from 'react-aria'
import { type ComboBoxState, type Node } from 'react-stately'
import { type ComboBoxItem } from './ComboBoxItem.ts'
import { ComboBoxOptionContent } from './ComboBoxOptionContent.tsx'

// One option in a ComboBox's list (fm-combo__opt): React Aria's useOption on kit.css's markup.
// kit.css highlights the option marked aria-selected, so that marks the option the keyboard is on,
// as in the ARIA combobox pattern; the selected option has a check.
export function ComboBoxOption({
  item,
  state,
  query,
}: {
  item: Node<ComboBoxItem>
  state: ComboBoxState<ComboBoxItem>
  query: string
}) {
  const ref = useRef<HTMLLIElement>(null)
  const { optionProps, isFocused, isSelected } = useOption({ key: item.key }, state, ref)
  return (
    <li {...optionProps} ref={ref} className="fm-combo__opt" aria-selected={isFocused}>
      <ComboBoxOptionContent item={item.value!} query={query} isSelected={isSelected} />
    </li>
  )
}
