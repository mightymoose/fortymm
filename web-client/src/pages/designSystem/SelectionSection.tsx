import { useState } from 'react'
import { FilterChips } from '../../components/FilterChips'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Switch } from '../../components/Switch'
import { Tabs, type Tab } from '../../components/Tabs'
import { GallerySection } from './GallerySection'

const tournamentSections: Tab[] = [
  { label: 'Overview', panel: <p className="fm-help">32 players · 4 tables · expected finish 18:45</p> },
  { label: 'Schedule', panel: <p className="fm-help">14 of 31 matches played.</p> },
  { label: 'Standings', panel: <p className="fm-help">Groups A–D, top two advance.</p> },
]

// The design system page's Selection section: the reference gallery's
// `section-selection`. It has no examples, only four controls side by side,
// each over its name and when to use it. The filter chips' line says which
// events they show.
export function SelectionSection() {
  const [shownEvents, setShownEvents] = useState(['All events'])
  return (
    <GallerySection
      id="selection"
      title="Selection"
      lead="Four controls that look related but do different jobs."
    >
      <div className="doc-use" style={{ marginTop: 48 }}>
        <div>
          <Tabs
            label="Tournament sections"
            tabs={tournamentSections}
            panelStyle={{ paddingTop: 12 }}
          />
          <h4>Tabs</h4>
          <p>
            Move between sibling sections of one page. The whole content area
            changes. Arrow keys move between tabs.
          </p>
        </div>
        <div>
          <SegmentedControl
            label="Schedule view"
            options={['Timeline', 'List', 'By player']}
          />
          <h4>Segmented control</h4>
          <p>
            Change how the same data is shown. Exactly one option is always
            on. Use 2–4 short options.
          </p>
        </div>
        <div>
          <FilterChips
            label="Filter by event"
            allLabel="All events"
            options={['Open singles', 'Under 18', 'Doubles']}
            onChange={setShownEvents}
          />
          <h4>Filter chips</h4>
          <p>
            Narrow a list. Several events can be on together. "All events"
            clears them, and switches back on when none are left.
          </p>
          <p className="fm-help" style={{ marginTop: 8 }}>
            Showing: {shownEvents.join(', ')}
          </p>
        </div>
        <div>
          <Switch defaultChecked>Call players automatically</Switch>
          <h4>Switch</h4>
          <p>
            A setting that takes effect immediately and stays. Never for
            filtering or changing views.
          </p>
        </div>
      </div>
    </GallerySection>
  )
}
