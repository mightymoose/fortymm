import { useId, useState, type Ref } from 'react'
import { useAnnounce } from '../../components/announceContext'
import type { CalendarConfig } from '../../components/calendarState'
import { CodeInput } from '../../components/CodeInput'
import { Combobox, type ComboboxHandle, type ComboboxOption } from '../../components/Combobox'
import { DateField } from '../../components/DateField'
import { FieldError } from '../../components/FieldError'
import { Icon } from '../../components/Icon'
import { InlineCalendar } from '../../components/InlineCalendar'
import { Switch } from '../../components/Switch'
import { Example, GallerySection } from './GallerySection'
import { checkedInPlayers } from './players'

// The code on the poster, the only one that finds a tournament.
const TOURNAMENT_CODE = 'SP26RV'

// Both date pickers' settings. "Today" is fixed, as in the gallery, so the
// page looks the same whatever day it is.
const tournamentDate: CalendarConfig = {
  value: '2026-04-11',
  today: '2026-04-10',
  min: '2026-04-10',
}

// The Text field example. The venue has six tables, so the Table field
// shows its error until it holds 1 to 6.
function TextFieldDemo() {
  const ids = {
    name: useId(),
    nameHelp: useId(),
    club: useId(),
    table: useId(),
    tableError: useId(),
    fee: useId(),
    feeHelp: useId(),
    event: useId(),
    note: useId(),
  }
  const [table, setTable] = useState('9')
  const tableNumber = Number(table)
  const tableValid = tableNumber >= 1 && tableNumber <= 6

  return (
    <div className="doc-grid">
      <div className="fm-field">
        <label className="fm-label" htmlFor={ids.name}>
          Player name
        </label>
        <input
          id={ids.name}
          className="fm-input"
          defaultValue="Johansen-Whitfield, Annika"
          aria-describedby={ids.nameHelp}
        />
        <p className="fm-help" id={ids.nameHelp}>
          Surname first, as it should appear on the draw.
        </p>
      </div>
      <div className="fm-field">
        <label className="fm-label" htmlFor={ids.club}>
          Club <span className="opt">(optional)</span>
        </label>
        <input id={ids.club} className="fm-input" placeholder="Search clubs" />
      </div>
      <div className="fm-field">
        <label className="fm-label" htmlFor={ids.table}>
          Table
        </label>
        <input
          id={ids.table}
          className="fm-input fm-input--num"
          value={table}
          inputMode="numeric"
          aria-invalid={!tableValid}
          aria-describedby={ids.tableError}
          onChange={(event) => setTable(event.target.value)}
        />
        <FieldError id={ids.tableError} hidden={tableValid}>
          This venue has 6 tables. Enter 1–6.
        </FieldError>
      </div>
      <div className="fm-field">
        <label className="fm-label" htmlFor={ids.fee}>
          Entry fee
        </label>
        <input
          id={ids.fee}
          className="fm-input"
          defaultValue="Free"
          disabled
          aria-describedby={ids.feeHelp}
        />
        <p className="fm-help" id={ids.feeHelp}>
          Set by the club. Can't be changed here.
        </p>
      </div>
      <div className="fm-field">
        <label className="fm-label" htmlFor={ids.event}>
          Event
        </label>
        <select id={ids.event} className="fm-select">
          <option>Open singles</option>
          <option>Under 18 singles</option>
          <option>Over 40 singles</option>
          <option>Open doubles</option>
        </select>
      </div>
      <div className="fm-field">
        <label className="fm-label" htmlFor={ids.note}>
          Note for players
        </label>
        <textarea
          id={ids.note}
          className="fm-textarea"
          defaultValue="Warm-up on tables 5 and 6 from 9:00."
        />
      </div>
    </div>
  )
}

// The Code input example. A full code finds Spring Open 2026 if it's
// SP26RV, and shows an error otherwise. Editing the code clears either.
function CodeInputDemo() {
  const ids = {
    label: useId(),
    help: useId(),
    error: useId(),
    closedLabel: useId(),
    closedHelp: useId(),
  }
  const announce = useAnnounce()
  const [found, setFound] = useState<boolean | null>(null)

  return (
    <div className="doc-grid" style={{ alignItems: 'start' }}>
      <div className="fm-field">
        <span className="fm-label" id={ids.label}>
          Tournament code
        </span>
        <CodeInput
          data-testid="code-input"
          split={3}
          aria-labelledby={ids.label}
          describedBy={found === false ? `${ids.error} ${ids.help}` : ids.help}
          invalid={found === false}
          onInput={() => setFound(null)}
          onComplete={(code) => {
            const ok = code === TOURNAMENT_CODE
            setFound(ok)
            announce(ok ? 'Spring Open 2026 found' : 'No tournament uses that code')
          }}
        />
        <p className="fm-help" id={ids.help}>
          On the poster at the venue entrance. Try SP26RV.
        </p>
        <FieldError id={ids.error} hidden={found !== false}>
          No tournament uses that code. Check the poster or ask the desk.
        </FieldError>
        <p className="fm-notice fm-notice--success" hidden={found !== true}>
          <Icon name="check" />
          <span>
            <b>Spring Open 2026</b> · Riverside Sports Hall · 11 April
          </span>
        </p>
      </div>
      <div className="fm-field">
        <span className="fm-label" id={ids.closedLabel} style={{ color: 'var(--fg-3)' }}>
          Tournament code
        </span>
        <CodeInput
          split={3}
          aria-labelledby={ids.closedLabel}
          describedBy={ids.closedHelp}
          disabled
        />
        <p className="fm-help" id={ids.closedHelp}>
          Entries for this tournament have closed.
        </p>
      </div>
    </div>
  )
}

// The Combobox example. The line under it says who was picked.
function ComboboxDemo({ opponent }: { opponent: Ref<ComboboxHandle> }) {
  const inputId = useId()
  const helpId = useId()
  const [picked, setPicked] = useState<ComboboxOption | null>(null)

  return (
    <div className="doc-grid" style={{ alignItems: 'start' }}>
      <div className="fm-field">
        <label className="fm-label" htmlFor={inputId}>
          Opponent
        </label>
        <Combobox
          ref={opponent}
          id={inputId}
          label="Opponent"
          data-testid="combobox-opponent"
          options={checkedInPlayers}
          placeholder="Search players or clubs"
          aria-describedby={helpId}
          onChange={setPicked}
        />
        <p className="fm-help" id={helpId}>
          Only checked-in players are listed.
        </p>
      </div>
      <p className="fm-help" aria-hidden="true">
        {picked ? `Picked: ${picked.name} · ${picked.club}` : 'Nothing picked yet.'}
      </p>
    </div>
  )
}

// The Checkbox, radio and switch example, with the rest slider under it.
function ChoicesDemo() {
  const matchLength = useId()
  const restId = useId()
  const [rest, setRest] = useState(15)

  return (
    <>
      <div className="doc-grid">
        <fieldset className="fm-choices">
          <legend>Before the match</legend>
          <label className="fm-check">
            <input type="checkbox" defaultChecked />
            Checked in
          </label>
          <label className="fm-check">
            <input type="checkbox" />
            Needs an umpire
          </label>
          <label className="fm-check">
            <input
              type="checkbox"
              ref={(box) => {
                if (box) box.indeterminate = true
              }}
            />
            All players (12 of 16)
          </label>
          <label className="fm-check">
            <input type="checkbox" disabled />
            Paid online (not enabled)
          </label>
        </fieldset>
        <fieldset className="fm-choices">
          <legend>Match length</legend>
          <label className="fm-radio">
            <input type="radio" name={matchLength} />
            Best of 3
          </label>
          <label className="fm-radio">
            <input type="radio" name={matchLength} defaultChecked />
            Best of 5
          </label>
          <label className="fm-radio">
            <input type="radio" name={matchLength} />
            Best of 7
          </label>
          <label className="fm-radio">
            <input type="radio" name={matchLength} disabled />
            Timed (not for this event)
          </label>
        </fieldset>
        <div className="fm-choices">
          <span className="fm-label">Calling</span>
          <Switch defaultChecked>Call players automatically</Switch>
          <Switch>Show ratings to spectators</Switch>
          <Switch disabled>Text players (needs phone numbers)</Switch>
        </div>
      </div>
      <div className="fm-field" style={{ maxWidth: 420 }}>
        <label className="fm-label" htmlFor={restId}>
          Minimum rest between matches · <span className="num">{rest} min</span>
        </label>
        <input
          id={restId}
          type="range"
          className="fm-range"
          min={5}
          max={30}
          step={5}
          value={rest}
          onChange={(event) => setRest(Number(event.target.value))}
        />
      </div>
    </>
  )
}

// The design system page's Fields and choices section: the reference
// gallery's `section-forms`. The page holds the opponent combobox's
// `opponent` handle, so the command palette can search it for a player.
export function FieldsSection({ opponent }: { opponent: Ref<ComboboxHandle> }) {
  return (
    <GallerySection
      id="forms"
      title="Fields and choices"
      lead="Field and control edges are brighter than dividers, so you can find where to tap on a dark table-side screen."
    >
      <Example
        testId="ex-text-field"
        title="Text field"
        description="Label above, help below. An error adds a red edge, an icon and a sentence that says how to fix it — all three stay while the field is focused."
      >
        <TextFieldDemo />
      </Example>
      <Example
        testId="ex-code-input"
        title="Code input"
        description="Joining a tournament with the organizer's 6-character code. Type, paste or autofill — characters spread across the boxes. Backspace steps back, ← → move. Letters and numbers only; case doesn't matter."
      >
        <CodeInputDemo />
      </Example>
      <Example
        testId="ex-combobox"
        title="Combobox"
        description="Searchable player picker. Matches surname, first name or club, ignoring accents (“wojcik” finds Wójcik). Club and rating tell same-name players apart. ↓ ↑ move, Enter picks, Esc closes, Esc again clears."
      >
        <ComboboxDemo opponent={opponent} />
      </Example>
      <Example
        testId="ex-date-picker"
        title="Date picker"
        description="Type a date (11 April 2026, 11/4/2026, Sat 11 Apr) or open the calendar. Typed dates are checked when you leave the field or press Enter, then shown in full. Selected day in orange; today outlined; past days struck through. Alt+↓ opens the calendar from the field. Arrows move by day and week, Page Up/Down by month, Esc closes and returns focus."
      >
        <div className="doc-grid" style={{ alignItems: 'start' }}>
          <DateField
            data-testid="datepicker-field"
            label="Tournament date"
            help="Players see this on the entry page."
            config={tournamentDate}
          />
          <div data-testid="datepicker-inline">
            <p className="doc-cap">Inline, for scheduling screens</p>
            <InlineCalendar config={tournamentDate} />
          </div>
        </div>
      </Example>
      <Example
        testId="ex-checkbox-radio-and-switch"
        title="Checkbox, radio and switch"
        description="Native inputs, keyboard-operable. Unchecked boxes have a 1.5px bright edge. Switches show state by fill and knob position."
      >
        <ChoicesDemo />
      </Example>
    </GallerySection>
  )
}
