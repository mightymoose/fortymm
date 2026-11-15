import type { ReactNode } from 'react'
import { Button, type ButtonVariant } from './Button.tsx'
import { Checkbox } from './controls-tab/Checkbox.tsx'
import { Field } from './Field.tsx'
import { FilterChip } from './controls-tab/FilterChip.tsx'
import { FilterChips } from './controls-tab/FilterChips.tsx'
import type { ForcedState } from './forced-state.ts'
import { Icon } from './Icon.tsx'
import { Radio } from './controls-tab/Radio.tsx'
import { SegmentedControl } from './controls-tab/SegmentedControl.tsx'
import { Select } from './controls-tab/Select.tsx'
import { Switch } from './Switch.tsx'
import { Tabs } from './Tabs.tsx'
import { TextArea } from './controls-tab/TextArea.tsx'
import { TextInput } from './TextInput.tsx'
import {
  Board,
  BoardGrid,
  BoardSection,
  Spec,
  Stage,
  type StageLayout,
} from './Board.tsx'
import './ControlsTab.css'

// The design system page's Controls tab (/design-system/controls): each
// control the app has, in each state, laid out as the reference sheet's
// "Controls: state matrix" board (references/design-system/Controls.dc.html),
// with the board's data-testid on each target, so a screenshot of a target
// here can be set beside the same target there.
//
// In the state matrices, hover, focus and pressed are forced (forcedState:
// the control is drawn in that state, forced-state.ts) and the controls are
// inert, so the pointer and the keyboard can't change what they show. The
// controls below the matrices (sizes, fields, groups) are live.
export function ControlsTab() {
  return (
    <Board
      id="controls"
      title="Controls"
      intro="Each control in each state. In the state matrices, hover, focus and pressed are forced and the controls are inert; below them, the controls are live."
    >
      <BoardSection
        id="controls-buttons"
        testId="section-buttons"
        title="Buttons"
        description={
          <>
            Disabled wins over hover. Loading keeps the variant colours and shows
            a static ring.
          </>
        }
      >
        {matrix({
          testId: 'state-matrix-buttons',
          label: 'Buttons in each state',
          states: [
            ['default', 'Default'],
            ['hover', 'Hover'],
            ['focus', 'Focus'],
            ['pressed', 'Pressed'],
            ['disabled', 'Disabled (on hover)'],
            ['loading', 'Loading'],
          ],
          rows: [
            buttonRow('primary', 'Primary', 'Call to table', {
              busy: 'Saving…',
            }),
            buttonRow('secondary', 'Secondary', 'Reschedule', {
              busy: 'Exporting…',
            }),
            buttonRow('ghost', 'Ghost', 'Print sheet', { busy: 'Printing…' }),
            buttonRow('danger', 'Danger', 'Withdraw…'),
            // Disabled on its own: the board doesn't draw this one hovered.
            buttonRow('danger-solid', 'Danger solid', 'Withdraw', {
              disabledHovered: false,
            }),
            {
              id: 'link-button',
              name: 'Link',
              cells: {
                default: <Button variant="link">View draw</Button>,
                hover: (
                  <Button variant="link" forcedState="hover">
                    View draw
                  </Button>
                ),
                focus: (
                  <Button variant="link" forcedState="focus">
                    View draw
                  </Button>
                ),
              },
            },
          ],
        })}
      </BoardSection>

      <BoardSection
        id="controls-button-sizes"
        testId="section-button-sizes"
        title="Button sizes"
        description={
          <>
            sm 32 · default 40 · lg 48 · xl 64 (score pad targets) · icon 40
            square.
          </>
        }
      >
        <Stage testId="button-sizes" layout="bottom">
          <Button variant="primary" size="sm" data-testid="button-size-sm">
            Call to table
          </Button>
          <Button variant="primary" data-testid="button-size-md">
            Call to table
          </Button>
          <Button variant="primary" size="lg" data-testid="button-size-lg">
            Call to table
          </Button>
          <Button variant="primary" size="xl" data-testid="button-size-xl">
            +1 Nguyen
          </Button>
          <Button
            variant="secondary"
            iconOnly
            aria-label="More actions"
            data-testid="button-size-icon"
          >
            <Icon name="ellipsis" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close"
            data-testid="button-size-icon-sm"
          >
            <Icon name="x" size="sm" />
          </Button>
          <Button variant="secondary" data-testid="button-with-icon">
            <Icon name="plus" />
            Add player
          </Button>
        </Stage>
      </BoardSection>

      <BoardSection
        id="controls-fields"
        testId="section-fields"
        title="Fields"
        description={
          <>
            Interactive edges use <code>--border-field</code>. A focused invalid
            field keeps its red edge, icon and message; the ring is added
            outside.
          </>
        }
      >
        {matrix({
          testId: 'state-matrix-fields',
          label: 'Fields in each state',
          states: [
            ['default', 'Default'],
            ['hover', 'Hover'],
            ['focus', 'Focus'],
            ['disabled', 'Disabled'],
            ['error', 'Error'],
            ['error-focus', 'Error + focus'],
          ],
          rows: [
            {
              id: 'text-field',
              name: 'Text field',
              cells: {
                default: nameInput(),
                hover: nameInput('hover'),
                focus: nameInput('focus'),
                disabled: (
                  <TextInput
                    defaultValue="Free"
                    aria-label="Fee"
                    disabled
                    forcedState="hover"
                  />
                ),
                error: tableField(),
                'error-focus': tableField('focus'),
              },
            },
            {
              id: 'select',
              name: 'Select',
              cells: {
                default: eventSelect(),
                hover: eventSelect('hover'),
                focus: eventSelect('focus'),
                disabled: (
                  <Select aria-label="Event" disabled>
                    <option>Open singles</option>
                  </Select>
                ),
                error: eventField(),
                'error-focus': eventField('focus'),
              },
            },
          ],
        })}
        <BoardGrid columns={3}>
          {spec({
            testId: 'field-anatomy',
            title: 'Field: label, placeholder, help',
            component: 'Field',
            layout: 'column',
            example: (
              <Field
                label="Club"
                optional
                help="Shown next to your name in draws."
              >
                {(control) => (
                  <TextInput {...control} placeholder="Search clubs" />
                )}
              </Field>
            ),
          })}
          {spec({
            testId: 'field-error',
            title: 'Field with error',
            component: 'aria-invalid',
            layout: 'column',
            example: (
              <Field label="Rating" error="Ratings go up to 3,000.">
                {(control) => (
                  <TextInput {...control} numeric defaultValue="12000" />
                )}
              </Field>
            ),
          })}
          {spec({
            testId: 'field-textarea',
            title: 'Text area',
            component: 'TextArea',
            layout: 'column',
            example: (
              <Field label="Note to players">
                {(control) => (
                  <TextArea {...control} placeholder="Doors open at 9:00." />
                )}
              </Field>
            ),
          })}
        </BoardGrid>
      </BoardSection>

      <BoardSection
        id="controls-choices"
        testId="section-choices"
        title="Choices and selection"
        description={
          <>
            Selected always has a non-colour cue: a check, a knob position, a
            filled weight or an underline.
          </>
        }
      >
        {matrix({
          testId: 'state-matrix-choices',
          label: 'Choices in each state',
          states: [
            ['default', 'Default'],
            ['hover', 'Hover'],
            ['focus', 'Focus'],
            ['selected', 'Selected / on'],
            ['disabled', 'Disabled'],
            ['disabled-on', 'Disabled + on'],
          ],
          rows: [
            {
              id: 'checkbox',
              name: 'Checkbox',
              cells: {
                default: <Checkbox>Umpire</Checkbox>,
                hover: <Checkbox forcedState="hover">Umpire</Checkbox>,
                focus: <Checkbox forcedState="focus">Umpire</Checkbox>,
                // With the mixed checkbox beside it, a target of its own.
                selected: (
                  <>
                    <Checkbox defaultChecked>Umpire</Checkbox>
                    <span
                      className="controls__target"
                      data-testid="state-checkbox--mixed"
                    >
                      <Checkbox indeterminate>Some</Checkbox>
                    </span>
                  </>
                ),
                disabled: <Checkbox disabled>Umpire</Checkbox>,
                'disabled-on': (
                  <Checkbox defaultChecked disabled>
                    Umpire
                  </Checkbox>
                ),
              },
            },
            {
              id: 'radio',
              name: 'Radio',
              cells: {
                default: <Radio>Best of 3</Radio>,
                hover: <Radio forcedState="hover">Best of 3</Radio>,
                focus: <Radio forcedState="focus">Best of 3</Radio>,
                selected: <Radio defaultChecked>Best of 5</Radio>,
                disabled: <Radio disabled>Timed</Radio>,
              },
            },
            {
              id: 'switch',
              name: 'Switch',
              cells: {
                default: <Switch>Auto-call</Switch>,
                hover: <Switch forcedState="hover">Auto-call</Switch>,
                focus: <Switch forcedState="focus">Auto-call</Switch>,
                selected: <Switch defaultChecked>Auto-call</Switch>,
                disabled: <Switch disabled>Auto-call</Switch>,
              },
            },
            {
              id: 'filter-chip',
              name: 'Filter chip',
              cells: {
                default: <FilterChip pressed={false}>Doubles</FilterChip>,
                hover: (
                  <FilterChip pressed={false} forcedState="hover">
                    Doubles
                  </FilterChip>
                ),
                focus: (
                  <FilterChip pressed={false} forcedState="focus">
                    Doubles
                  </FilterChip>
                ),
                selected: <FilterChip pressed>Doubles</FilterChip>,
                disabled: (
                  <FilterChip pressed={false} disabled>
                    Doubles
                  </FilterChip>
                ),
              },
            },
            {
              id: 'segmented-option',
              name: 'Segmented option',
              cells: {
                default: segment(),
                hover: segment({ forcedState: 'hover' }),
                focus: segment({ forcedState: 'focus' }),
                selected: segment({ selected: true }),
                disabled: segment({ disabled: true }),
              },
            },
            {
              id: 'tab',
              name: 'Tab',
              cells: {
                default: tab(),
                hover: tab({ forcedState: 'hover' }),
                focus: tab({ forcedState: 'focus' }),
                selected: tab({ selected: true }),
                disabled: tab({ disabled: true }),
              },
            },
          ],
        })}
      </BoardSection>

      <BoardSection
        id="controls-selection-groups"
        testId="section-selection-groups"
        title="Selection groups"
        description={
          <>
            Tabs switch sibling sections. Segmented is another view of the same
            data. Chips narrow a list. Never a switch to filter.
          </>
        }
      >
        <BoardGrid columns={3}>
          {spec({
            testId: 'group-tabs',
            title: 'Tabs',
            component: 'Tabs',
            layout: 'block',
            example: (
              <Tabs
                label="Event pages"
                defaultValue="schedule"
                tabs={[
                  { value: 'schedule', label: 'Schedule' },
                  { value: 'draw', label: 'Draw' },
                  { value: 'players', label: 'Players' },
                  { value: 'results', label: 'Results' },
                ]}
              />
            ),
          })}
          {spec({
            testId: 'group-segmented',
            title: 'Segmented',
            component: 'SegmentedControl',
            layout: 'row',
            example: (
              <SegmentedControl
                label="View"
                defaultValue="list"
                options={[
                  { value: 'list', label: 'List' },
                  { value: 'timeline', label: 'Timeline' },
                  { value: 'tables', label: 'Tables' },
                ]}
              />
            ),
          })}
          {spec({
            testId: 'group-chips',
            title: 'Filter chips',
            component: 'FilterChips',
            layout: 'row',
            example: (
              <FilterChips
                label="Events"
                allLabel="All events"
                defaultOn={['open-singles', 'doubles']}
                options={[
                  { value: 'open-singles', label: 'Open singles' },
                  { value: 'doubles', label: 'Doubles' },
                  { value: 'u-2000', label: 'U-2000' },
                ]}
              />
            ),
          })}
        </BoardGrid>
      </BoardSection>
    </Board>
  )
}

type MatrixRow = {
  // The board's component id: the row is state-<id>, each cell
  // state-<id>--<state>.
  id: string
  name: string
  // The control in each state, by the state's name. A state the control
  // doesn't have is left out, and its cell says so.
  cells: Partial<Record<string, ReactNode>>
}

// A state matrix: a table with a column per state and a row per control.
// Its body is inert: the cells show forced states, which the pointer and the
// keyboard must not change.
function matrix({
  testId,
  label,
  states,
  rows,
}: {
  testId: string
  label: string
  states: [state: string, heading: string][]
  rows: MatrixRow[]
}) {
  return (
    <table className="state-matrix" aria-label={label} data-testid={testId}>
      <thead>
        <tr>
          <th scope="col">
            <span className="visually-hidden">Component</span>
          </th>
          {states.map(([state, heading]) => (
            <th key={state} scope="col">
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody inert>
        {rows.map((row) => (
          <tr key={row.id} data-testid={`state-${row.id}`}>
            <th scope="row">{row.name}</th>
            {states.map(([state]) =>
              row.cells[state] === undefined ? (
                <td key={state} className="state-matrix__none">
                  —
                </td>
              ) : (
                <td key={state}>
                  <Stage testId={`state-${row.id}--${state}`}>
                    {row.cells[state]}
                  </Stage>
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// A button variant's row: default, hover, focus, pressed, disabled (drawn
// hovered, which it ignores, unless `disabledHovered` is false) and, where
// `busy` is given, loading with that label.
function buttonRow(
  variant: ButtonVariant,
  name: string,
  label: string,
  {
    busy,
    disabledHovered = true,
  }: { busy?: string; disabledHovered?: boolean } = {},
): MatrixRow {
  return {
    id: `${variant}-button`,
    name,
    cells: {
      default: <Button variant={variant}>{label}</Button>,
      hover: (
        <Button variant={variant} forcedState="hover">
          {label}
        </Button>
      ),
      focus: (
        <Button variant={variant} forcedState="focus">
          {label}
        </Button>
      ),
      pressed: (
        <Button variant={variant} forcedState="pressed">
          {label}
        </Button>
      ),
      disabled: (
        <Button
          variant={variant}
          disabled
          forcedState={disabledHovered ? 'hover' : undefined}
        >
          {label}
        </Button>
      ),
      loading:
        busy === undefined ? undefined : (
          <Button variant={variant} loading>
            {busy}
          </Button>
        ),
    },
  }
}

function nameInput(forcedState?: ForcedState) {
  return (
    <TextInput
      defaultValue="Park, Ji-ho"
      aria-label="Name"
      forcedState={forcedState}
    />
  )
}

// The board's invalid "Table" field: its label is for assistive technology
// only.
function tableField(forcedState?: ForcedState) {
  return (
    <Field label="Table" hideLabel error="Enter 1–6.">
      {(control) => (
        <TextInput
          {...control}
          numeric
          defaultValue="9"
          forcedState={forcedState}
        />
      )}
    </Field>
  )
}

function eventSelect(forcedState?: ForcedState) {
  return (
    <Select aria-label="Event" forcedState={forcedState}>
      <option>Open singles</option>
    </Select>
  )
}

// The board's invalid "Event" select.
function eventField(forcedState?: ForcedState) {
  return (
    <Field label="Event" hideLabel error="Pick an event.">
      {(control) => (
        <Select {...control} forcedState={forcedState}>
          <option>Choose…</option>
        </Select>
      )}
    </Field>
  )
}

// One option of a segmented control, alone, in one state.
function segment({
  forcedState,
  selected = false,
  disabled = false,
}: {
  forcedState?: ForcedState
  selected?: boolean
  disabled?: boolean
} = {}) {
  return (
    <SegmentedControl
      label="View"
      defaultValue={selected ? 'list' : undefined}
      options={[{ value: 'list', label: 'List', forcedState, disabled }]}
    />
  )
}

// One tab, alone, in one state, without the tab row's rule.
function tab({
  forcedState,
  selected = false,
  disabled = false,
}: {
  forcedState?: ForcedState
  selected?: boolean
  disabled?: boolean
} = {}) {
  return (
    <div className="controls__lone-tab">
      <Tabs
        label="Event pages"
        defaultValue={selected ? 'schedule' : undefined}
        tabs={[{ value: 'schedule', label: 'Schedule', forcedState, disabled }]}
      />
    </div>
  )
}

// One example below the matrices: its stage (the screenshot target), laid
// out in a row (centred), a column (stretched to the stage's width) or as a
// block (filling it), and a caption outside the stage naming the example and
// the component.
function spec({
  testId,
  title,
  component,
  layout,
  example,
}: {
  testId: string
  title: string
  component: string
  layout: StageLayout
  example: ReactNode
}) {
  return (
    <Spec title={title} detail={component}>
      <Stage testId={testId} layout={layout}>
        {example}
      </Stage>
    </Spec>
  )
}
