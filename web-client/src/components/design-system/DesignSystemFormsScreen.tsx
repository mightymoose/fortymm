import { CalendarDate } from '@internationalized/date'
import { useId, useState } from 'react'
import { I18nProvider } from 'react-aria'
import { Calendar } from '../../design-system/Calendar.tsx'
import { Checkbox } from '../../design-system/Checkbox.tsx'
import { CodeInput } from '../../design-system/CodeInput.tsx'
import { ComboBox } from '../../design-system/ComboBox.tsx'
import { type ComboBoxItem } from '../../design-system/ComboBoxItem.ts'
import { DateField } from '../../design-system/DateField.tsx'
import { Fieldset } from '../../design-system/Fieldset.tsx'
import { FilterChips } from '../../design-system/FilterChips.tsx'
import { Notice } from '../../design-system/Notice.tsx'
import { type Option } from '../../design-system/Option.ts'
import { Radio } from '../../design-system/Radio.tsx'
import { RadioGroup } from '../../design-system/RadioGroup.tsx'
import { RangeField } from '../../design-system/RangeField.tsx'
import { SegmentedControl } from '../../design-system/SegmentedControl.tsx'
import { Select } from '../../design-system/Select.tsx'
import { Switch } from '../../design-system/Switch.tsx'
import { Tabs } from '../../design-system/Tabs.tsx'
import { TextArea } from '../../design-system/TextArea.tsx'
import { TextField } from '../../design-system/TextField.tsx'
import './showcase.css'
import { ShowcaseExample } from './ShowcaseExample.tsx'
import { StaticComboBox } from './StaticComboBox.tsx'

// The players the combobox picks from. The board shows only the two that match “ngu”; the others
// are there to be filtered out.
const players: ComboBoxItem[] = [
  { id: 'nguyen-thanh', name: 'Nguyen, Thanh', description: 'Riverside TT', meta: '2,145' },
  { id: 'nguyen-linh', name: 'Nguyen, Linh', description: 'Eastgate', meta: '1,702' },
  { id: 'park-ji-ho', name: 'Park, Ji-ho', description: 'Riverside TT', meta: '1,980' },
  { id: 'patel-meera', name: 'Patel, Meera', description: 'Northside', meta: '1,856' },
  { id: 'rossi-giulia', name: 'Rossi, Giulia', description: 'Eastgate', meta: '1,744' },
]

// The board fixes today at Friday 10 April 2026, the day before the tournament.
const showcaseToday = new CalendarDate(2026, 4, 10)
const tournamentDate = new CalendarDate(2026, 4, 11)

// What each tab of the tournament shows. The board draws only the first.
const tournamentSections: Record<string, string> = {
  overview: '32 players · 4 tables · expected finish 18:45',
  schedule: 'Round of 16 from 11:00 · quarter-finals from 14:30',
  standings: 'Group stage complete · 16 players through',
}

// The events the filter chips narrow by.
const events: Option[] = [
  { id: 'open-singles', label: 'Open singles' },
  { id: 'under-18', label: 'Under 18' },
  { id: 'doubles', label: 'Doubles' },
]

// The design system's Forms board (requirements/design-system/reference/Forms.dc.html): fields,
// choices and selection controls. Text is copied from the board.
export function DesignSystemFormsScreen() {
  const callingLabel = useId()
  const [shownEvents, setShownEvents] = useState<string[]>(['open-singles', 'under-18'])
  return (
    <main className="doc" data-testid="page-forms">
      <section className="doc-cat" data-testid="section-forms">
        <h2>Fields and choices</h2>
        <p>
          Field and control edges are brighter than dividers, so you can find where to tap on a dark
          table-side screen.
        </p>
        <ShowcaseExample
          testId="ex-text-field"
          title="Text field"
          description="Label above, help below. An error adds a red edge, an icon and a sentence that says how to fix it — all three stay while the field is focused."
        >
          <div className="doc-grid">
            <TextField
              label="Player name"
              defaultValue="Johansen-Whitfield, Annika"
              description="Surname first, as it should appear on the draw."
            />
            <TextField label="Club" isOptional placeholder="Search clubs" />
            <TextField
              label="Table"
              defaultValue="9"
              isNumeric
              isInvalid
              errorMessage="This venue has 6 tables. Enter 1–6."
            />
            <TextField
              label="Entry fee"
              defaultValue="Free"
              isDisabled
              description="Set by the club. Can't be changed here."
            />
            <Select
              label="Event"
              options={['Open singles', 'Under 18 singles', 'Over 40 singles', 'Open doubles']}
            />
            <TextArea label="Note for players" defaultValue="Warm-up on tables 5 and 6 from 9:00." />
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-code-input"
          title="Code input"
          description="Joining a tournament with the organizer's 6-character code. Characters spread across the boxes; letters and numbers only."
        >
          <div className="doc-grid2">
            <CodeInput label="Tournament code" defaultValue="SP26RV">
              <Notice tone="success">
                <b>Spring Open 2026</b> · Riverside Sports Hall · 11 April
              </Notice>
            </CodeInput>
            <CodeInput
              label="Tournament code"
              defaultValue="SP26RX"
              isInvalid
              errorMessage="No tournament uses that code. Check the poster or ask the desk."
            />
            <CodeInput
              label="Tournament code"
              isDisabled
              description="Entries for this tournament have closed."
            />
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-combobox"
          title="Combobox"
          description="Searchable player picker, shown open with “ngu” typed. Matches are bolded; club and rating tell same-name players apart."
        >
          <div className="doc-grid2">
            <div style={{ paddingBottom: 150 }}>
              <StaticComboBox label="Opponent" listLabel="Players" items={players} query="ngu" />
            </div>
            <ComboBox
              label="Opponent"
              items={players}
              placeholder="Search players or clubs"
              description="Only checked-in players are listed."
            />
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-date-picker"
          title="Date picker"
          description="Typed or picked. Selected day in orange; today outlined; past days struck through. Today is fixed at 10 April 2026."
        >
          {/* The board writes its dates in British English, whatever the browser's language. */}
          <I18nProvider locale="en-GB">
            <div className="doc-grid2">
              <DateField
                label="Tournament date"
                defaultValue={tournamentDate}
                today={showcaseToday}
                minValue={showcaseToday}
                description="Players see this on the entry page."
              />
              <div>
                <p className="doc-cap">Inline, for scheduling screens</p>
                <Calendar
                  aria-label="Choose date"
                  defaultValue={tournamentDate}
                  today={showcaseToday}
                  minValue={showcaseToday}
                />
              </div>
            </div>
          </I18nProvider>
        </ShowcaseExample>
        <ShowcaseExample
          testId="ex-checkbox-radio-and-switch"
          title="Checkbox, radio and switch"
          description="Native inputs, keyboard-operable. Unchecked boxes have a 1.5px bright edge. Switches show state by fill and knob position."
        >
          <div className="doc-grid">
            <Fieldset legend="Before the match">
              <Checkbox defaultSelected>Checked in</Checkbox>
              <Checkbox>Needs an umpire</Checkbox>
              <Checkbox isIndeterminate>All players (12 of 16)</Checkbox>
              <Checkbox isDisabled>Paid online (not enabled)</Checkbox>
            </Fieldset>
            <RadioGroup label="Match length" defaultValue="5">
              <Radio value="3">Best of 3</Radio>
              <Radio value="5">Best of 5</Radio>
              <Radio value="7">Best of 7</Radio>
              <Radio value="timed" isDisabled>
                Timed (not for this event)
              </Radio>
            </RadioGroup>
            <div className="fm-choices" role="group" aria-labelledby={callingLabel}>
              <span className="fm-label" id={callingLabel}>
                Calling
              </span>
              <Switch defaultSelected>Call players automatically</Switch>
              <Switch>Show ratings to spectators</Switch>
              <Switch isDisabled>Text players (needs phone numbers)</Switch>
            </div>
          </div>
          <div style={{ maxWidth: 420 }}>
            <RangeField
              label="Minimum rest between matches"
              min={5}
              max={30}
              step={5}
              defaultValue={15}
              formatValue={(minutes) => `${minutes} min`}
            />
          </div>
        </ShowcaseExample>
      </section>
      <section className="doc-cat" data-testid="section-selection">
        <h2>Selection</h2>
        <p>Four controls that look related but do different jobs.</p>
        <div className="doc-use">
          <div data-testid="ex-tabs">
            <Tabs
              aria-label="Tournament sections"
              tabs={[
                { id: 'overview', label: 'Overview' },
                { id: 'schedule', label: 'Schedule' },
                { id: 'standings', label: 'Standings' },
              ]}
              defaultSelectedId="overview"
            >
              {(id) => (
                <div style={{ paddingTop: 12 }}>
                  <p className="fm-help" style={{ margin: 0 }}>
                    {tournamentSections[id]}
                  </p>
                </div>
              )}
            </Tabs>
            <h4>Tabs</h4>
            <p>Move between sibling sections of one page. The whole content area changes.</p>
          </div>
          <div data-testid="ex-segmented">
            <SegmentedControl
              aria-label="Schedule view"
              options={[
                { id: 'timeline', label: 'Timeline' },
                { id: 'list', label: 'List' },
                { id: 'by-player', label: 'By player' },
              ]}
              defaultSelectedId="timeline"
            />
            <h4>Segmented control</h4>
            <p>Change how the same data is shown. Exactly one option is always on. Use 2–4 short options.</p>
          </div>
          <div data-testid="ex-filter-chips">
            <FilterChips
              aria-label="Filter by event"
              allLabel="All events"
              options={events}
              defaultSelectedIds={shownEvents}
              onChange={setShownEvents}
            />
            <h4>Filter chips</h4>
            <p>
              Narrow a list. Several events can be on together. "All events" clears them, and switches
              back on when none are left.
            </p>
            <p className="fm-help" style={{ marginTop: 8 }}>
              Showing:{' '}
              {shownEvents.length
                ? events
                    .filter((event) => shownEvents.includes(event.id))
                    .map((event) => event.label)
                    .join(', ')
                : 'All events'}
            </p>
          </div>
          <div data-testid="ex-switch">
            <Switch defaultSelected>Call players automatically</Switch>
            <h4>Switch</h4>
            <p>A setting that takes effect immediately and stays. Never for filtering or changing views.</p>
          </div>
        </div>
      </section>
    </main>
  )
}
