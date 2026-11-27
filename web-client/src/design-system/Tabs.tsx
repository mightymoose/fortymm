import { type ReactNode, useRef } from 'react'
import { useTabList } from 'react-aria'
import { Item, useTabListState } from 'react-stately'
import { type Option } from './Option.ts'
import { Tab } from './Tab.tsx'
import { TabPanel } from './TabPanel.tsx'

// Move between sibling sections of one page; the whole content area changes. React Aria's
// useTabList on kit.css's markup (fm-tabs): a row of tab buttons, arrow keys between them, and
// below it the selected tab's content, which children gives for each tab id.
export function Tabs({
  'aria-label': ariaLabel,
  tabs,
  defaultSelectedId,
  children,
}: {
  'aria-label': string
  tabs: readonly Option[]
  defaultSelectedId?: string
  children: (id: string) => ReactNode
}) {
  const props = {
    'aria-label': ariaLabel,
    items: tabs,
    defaultSelectedKey: defaultSelectedId,
    children: (tab: Option) => <Item key={tab.id}>{tab.label}</Item>,
  }
  const state = useTabListState(props)
  const ref = useRef<HTMLDivElement>(null)
  const { tabListProps } = useTabList(props, state, ref)
  return (
    <>
      <div {...tabListProps} ref={ref} className="fm-tabs">
        {[...state.collection].map((item) => (
          <Tab key={item.key} item={item} state={state} />
        ))}
      </div>
      {state.selectedKey !== null && (
        <TabPanel key={state.selectedKey} state={state}>
          {children(String(state.selectedKey))}
        </TabPanel>
      )}
    </>
  )
}
