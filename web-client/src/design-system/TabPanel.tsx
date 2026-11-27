import { type ReactNode, useRef } from 'react'
import { useTabPanel } from 'react-aria'
import { type TabListState } from 'react-stately'
import { type Option } from './Option.ts'

// The content of the selected tab in Tabs: React Aria's useTabPanel, named by its tab.
export function TabPanel({
  state,
  children,
}: {
  state: TabListState<Option>
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { tabPanelProps } = useTabPanel({}, state, ref)
  return (
    <div {...tabPanelProps} ref={ref}>
      {children}
    </div>
  )
}
