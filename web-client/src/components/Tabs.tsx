import { useId, type CSSProperties, type ReactNode } from 'react'
import { useSingleSelect } from './singleSelect'

export type Tab = { label: string; panel: ReactNode }

// Tabs between sibling sections of one page, styled by `.fm-tabs` in
// styles/kit.css: a tablist, then each tab's panel, of which only the
// selected tab's shows. The first tab starts selected. Only the selected tab
// is a tab stop, and the arrow keys, Home and End select another.
// `panelStyle` styles every panel.
export function Tabs({
  label,
  tabs,
  panelStyle,
}: {
  label: string
  tabs: readonly Tab[]
  panelStyle?: CSSProperties
}) {
  const id = useId()
  const { selected, optionProps } = useSingleSelect(
    'tab',
    tabs.map((tab) => tab.label),
  )
  return (
    <>
      <div className="fm-tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            id={`${id}-tab${index}`}
            aria-controls={`${id}-panel${index}`}
            {...optionProps(index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.label}
          role="tabpanel"
          id={`${id}-panel${index}`}
          aria-labelledby={`${id}-tab${index}`}
          hidden={index !== selected}
          style={panelStyle}
        >
          {tab.panel}
        </div>
      ))}
    </>
  )
}
