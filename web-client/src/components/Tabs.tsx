import { useId, type ReactNode } from 'react'
import type { ForcedState } from './forced-state.ts'
import { useSingleSelection } from './single-selection.ts'
import './Tabs.css'

export type Tab = {
  value: string
  label: string
  disabled?: boolean
  // The section this tab shows. A tab without one only selects.
  panel?: ReactNode
  forcedState?: ForcedState
}

// Tabs (the design system's .fm-tabs): switch between sibling sections of a
// page. A tablist named by `label`, one tab per item, the selected one
// underlined in the accent and in a heavier weight. The arrow keys move
// between tabs and select them (single-selection.ts). Each tab with a `panel`
// controls a tabpanel after the list, shown while it is selected.
// `onChange` hears each new selection.
export function Tabs({
  label,
  tabs,
  defaultValue,
  onChange,
}: {
  label: string
  tabs: Tab[]
  defaultValue?: string
  onChange?: (value: string) => void
}) {
  const id = useId()
  const { selected, optionProps } = useSingleSelection({
    options: tabs,
    defaultValue,
    onChange,
  })
  const tabId = (tab: Tab) => `${id}-tab-${tab.value}`
  const panelId = (tab: Tab) => `${id}-panel-${tab.value}`

  return (
    <>
      <div role="tablist" aria-label={label} className="tabs">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            {...optionProps(tab)}
            type="button"
            role="tab"
            id={tabId(tab)}
            aria-selected={tab.value === selected}
            aria-controls={tab.panel === undefined ? undefined : panelId(tab)}
            className="tabs__tab"
            data-forced-state={tab.forcedState}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map(
        (tab) =>
          tab.panel !== undefined && (
            <div
              key={tab.value}
              role="tabpanel"
              id={panelId(tab)}
              aria-labelledby={tabId(tab)}
              tabIndex={0}
              hidden={tab.value !== selected}
            >
              {tab.panel}
            </div>
          ),
      )}
    </>
  )
}
