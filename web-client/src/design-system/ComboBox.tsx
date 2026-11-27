import { useRef } from 'react'
import { useComboBox, useFilter, useListBox } from 'react-aria'
import { Item, useComboBoxState } from 'react-stately'
import { type ComboBoxItem } from './ComboBoxItem.ts'
import { ComboBoxOption } from './ComboBoxOption.tsx'
import { Icon } from './Icon.tsx'

// A searchable picker (fm-combo): type to narrow the list, pick with the keyboard or pointer.
// React Aria's useComboBox, useListBox and useOption on kit.css's markup; the list drops below the
// field, positioned by kit.css, rather than in a popover. Matching ignores case and accents.
export function ComboBox({
  label,
  items,
  placeholder,
  description,
  defaultInputValue,
  onSelectionChange,
}: {
  label: string
  items: readonly ComboBoxItem[]
  placeholder?: string
  description?: string
  defaultInputValue?: string
  onSelectionChange?: (id: string | null) => void
}) {
  const { contains } = useFilter({ sensitivity: 'base' })
  const props = {
    label,
    placeholder,
    description,
    defaultItems: items,
    defaultInputValue,
    defaultFilter: contains,
    onSelectionChange: (key: unknown) => onSelectionChange?.(key === null ? null : String(key)),
    children: (item: ComboBoxItem) => (
      <Item key={item.id} textValue={item.name}>
        {item.name}
      </Item>
    ),
  }
  const state = useComboBoxState(props)
  const inputRef = useRef<HTMLInputElement>(null)
  const listBoxRef = useRef<HTMLUListElement>(null)
  const { labelProps, inputProps, listBoxProps, descriptionProps } = useComboBox(
    { ...props, inputRef, listBoxRef, popoverRef: listBoxRef },
    state,
  )
  const { listBoxProps: listProps } = useListBox(listBoxProps, state, listBoxRef)

  return (
    <div className="fm-field">
      <label {...labelProps} className="fm-label">
        {label}
      </label>
      <div className="fm-combo">
        <Icon name="search" />
        <input {...inputProps} ref={inputRef} className="fm-input" />
        {state.isOpen && (
          <ul {...listProps} ref={listBoxRef} className="fm-combo__list fm-overlay">
            {[...state.collection].map((item) => (
              <ComboBoxOption key={item.key} item={item} state={state} query={state.inputValue} />
            ))}
          </ul>
        )}
      </div>
      {description && (
        <p {...descriptionProps} className="fm-help">
          {description}
        </p>
      )}
    </div>
  )
}
