import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'

export type Tab = {
  value: string
  label: string
  panel: ReactNode
}

// Where each key moves the focus in a row of `count` tabs from `index`,
// wrapping at the ends.
const moves: Record<string, (index: number, count: number) => number> = {
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
}

// A row of tabs, each showing its own panel below the row, as in the
// WAI-ARIA tabs pattern: a `.tabs-list` tablist of `.tab` buttons, then the
// chosen tab's `.tab-content` tabpanel (styles/base.css). The row is one Tab
// stop, on the chosen tab. The arrow keys, Home and End move the focus and
// the choice along it, wrapping.
//
// It's uncontrolled: `defaultValue` sets the chosen tab, the first unless
// given. Name the tablist with `label`.
export function Tabs({
  label,
  tabs,
  defaultValue = tabs[0]?.value,
}: {
  label: string
  tabs: Tab[]
  defaultValue?: string
}) {
  const id = useId()
  const [selected, setSelected] = useState(defaultValue)
  const tabId = (value: string) => `${id}-tab-${value}`
  const panelId = (value: string) => `${id}-panel-${value}`

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const next = tabs[move(index, tabs.length)]
    setSelected(next.value)
    document.getElementById(tabId(next.value))?.focus()
  }

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tabs-list">
        {tabs.map((tab, index) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={tabId(tab.value)}
            aria-selected={tab.value === selected}
            aria-controls={panelId(tab.value)}
            tabIndex={tab.value === selected ? 0 : -1}
            className="tab"
            onClick={() => setSelected(tab.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.value}
          role="tabpanel"
          id={panelId(tab.value)}
          aria-labelledby={tabId(tab.value)}
          tabIndex={0}
          hidden={tab.value !== selected}
          className="tab-content"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  )
}
