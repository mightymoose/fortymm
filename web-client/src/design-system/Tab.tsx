import { useRef } from 'react'
import { useTab } from 'react-aria'
import { type Node, type TabListState } from 'react-stately'
import { type Option } from './Option.ts'

// One tab in Tabs: React Aria's useTab on kit.css's markup, a button in the tab list.
export function Tab({ item, state }: { item: Node<Option>; state: TabListState<Option> }) {
  const ref = useRef<HTMLButtonElement>(null)
  const { tabProps } = useTab({ key: item.key }, state, ref)
  return (
    <button {...tabProps} ref={ref} type="button">
      {item.rendered}
    </button>
  )
}
