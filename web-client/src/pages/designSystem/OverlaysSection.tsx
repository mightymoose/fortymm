import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Checkbox } from '../../components/Checkbox'
import { Command, type CommandGroup } from '../../components/Command'
import { ComponentCard } from '../../components/ComponentCard'
import { Dialog } from '../../components/Dialog'
import { Field, Label } from '../../components/Field'
import { Menu, type MenuEntry } from '../../components/Menu'
import { PlayerHoverCard } from '../../components/PlayerHoverCard'
import { Section } from '../../components/Section'
import { Select } from '../../components/Select'
import { Slider } from '../../components/Slider'
import { Tooltip } from '../../components/Tooltip'

// The Dropdown Menu · Context Menu card's menus: a match's actions, and the
// right-click menu of a bracket.
const matchActions: MenuEntry[] = [
  { kind: 'label', text: 'Match actions' },
  {
    kind: 'item',
    label: 'Rematch',
    shortcut: { label: '⌘ R', keys: 'Meta+R' },
  },
  {
    kind: 'item',
    label: 'Share match link',
    shortcut: { label: '⌘ ↑ S', keys: 'Meta+Shift+S' },
  },
  { kind: 'item', label: 'Edit score' },
  { kind: 'separator' },
  { kind: 'item', label: 'Forfeit', destructive: true },
]

const bracketActions: MenuEntry[] = [
  { kind: 'checkbox', label: 'Show seeds', checked: true },
  { kind: 'checkbox', label: 'Show ratings', checked: false },
  { kind: 'separator' },
  { kind: 'item', label: 'Reschedule…' },
  { kind: 'item', label: 'Print bracket' },
]

// The Command card's palette.
const commands: CommandGroup[] = [
  {
    heading: 'Suggestions',
    items: [
      {
        id: 'log-match',
        label: 'Log a match',
        shortcut: { label: '⌘ L', keys: 'Meta+L' },
      },
      {
        id: 'find-player',
        label: 'Find a player',
        shortcut: { label: '⌘ P', keys: 'Meta+P' },
      },
      {
        id: 'tournament-admin',
        label: 'Open tournament admin',
        shortcut: { label: '⌘ T', keys: 'Meta+T' },
      },
    ],
  },
  {
    heading: 'Recent',
    items: [
      { id: 'nguyen-okafor', label: 'Nguyen vs. Okafor · 2h ago' },
      { id: 'april-spring-open', label: 'April Spring Open · yesterday' },
    ],
  },
]

export function OverlaysSection() {
  return (
    <Section
      id="overlays"
      title="Overlays"
      lead="Dialogs, sheets, popovers, menus. Content that floats above the canvas. All shown in their open state."
    >
      {/* As the kit does, the overlays show only their open surface, in a
          frame, with no trigger to open or close them. */}
      <ComponentCard title="Dialog · Alert Dialog" tag="modal">
        <div className="grid-2">
          <div className="mock-bg mock-bg--dialog">
            <span className="mock-label">Dialog</span>
            <Dialog
              title="Forfeit this match?"
              description="Your opponent will be awarded the win and your rating will be adjusted accordingly. This can't be undone."
              actions={
                <>
                  <Button variant="outline">Cancel</Button>
                  <Button variant="destructive">Forfeit</Button>
                </>
              }
            >
              <Checkbox>Send a note to my opponent</Checkbox>
            </Dialog>
          </div>
          <div className="mock-bg mock-bg--dialog">
            <span className="mock-label">Alert Dialog</span>
            <Dialog
              variant="alert"
              title={
                <>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--warn)"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <path d="M12 9v4M12 17h0" />
                  </svg>
                  Delete account
                </>
              }
              description="All match history, ratings, and tournament records will be permanently deleted."
              actions={
                <>
                  <Button variant="outline">Keep account</Button>
                  <Button variant="destructive">Delete</Button>
                </>
              }
            />
          </div>
        </div>
      </ComponentCard>
      {/* The kit draws a bare label over the slider, with no readout. Its
          thumbs sit at 20% and 80% of the track. */}
      <ComponentCard title="Sheet" tag="side panel">
        <div className="mock-bg mock-bg--dialog mock-bg--sheet">
          <span className="mock-label">Sheet (right)</span>
          <Dialog
            variant="sheet"
            title="Filters"
            description="Narrow the player list."
          >
            <Field>
              <Label>Club</Label>
              <Select>
                <option>Brooklyn TT</option>
              </Select>
            </Field>
            <Field>
              <Slider
                min={1000}
                max={2500}
                defaultValue={[1300, 2200] as const}
                className="slider-field--plain"
              >
                Rating range
              </Slider>
            </Field>
            <Button className="button-wide">Apply filters</Button>
          </Dialog>
        </div>
      </ComponentCard>
      <ComponentCard title="Drawer" tag="mobile bottom sheet">
        <div className="mock-bg mock-bg--dialog mock-bg--drawer">
          <span className="mock-label">Drawer (bottom)</span>
          <Dialog
            variant="drawer"
            title="Quick log"
            description="Tap to record a finished match."
          >
            <Button className="button-wide">Pick opponent</Button>
          </Dialog>
        </div>
      </ComponentCard>
      <ComponentCard title="Popover" tag="contextual content">
        <div className="mock-bg mock-bg--popover">
          <span className="mock-label">Popover</span>
          <Dialog
            variant="popover"
            title="Skill rating"
            description="Your rating is calculated using a Glicko-2 system with a 0.06 volatility cap. Updates after every match."
          />
        </div>
      </ComponentCard>
      {/* The icon's tooltip explains it, so the button's own name is
          short. */}
      <ComponentCard title="Tooltip" tag="on hover">
        <div className="mock-bg mock-bg--tooltip">
          <span className="mock-label">Tooltip</span>
          <div className="row tooltip-demo">
            <Tooltip text="Refresh standings">
              {(tooltipId) => (
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Refresh"
                  aria-describedby={tooltipId}
                >
                  ↻
                </Button>
              )}
            </Tooltip>
            <Tooltip text="Highest rated player in this bracket">
              {(tooltipId) => (
                <Badge aria-describedby={tooltipId}>Seed 1</Badge>
              )}
            </Tooltip>
          </div>
        </div>
      </ComponentCard>
      <ComponentCard title="Hover Card" tag="player preview">
        <div className="mock-bg mock-bg--popover">
          <span className="mock-label">Hover Card</span>
          <PlayerHoverCard
            player={{
              name: 'Tien Nguyen',
              club: 'Brooklyn TT',
              joinedYear: 2024,
              rating: 1620,
              wins: 14,
              losses: 3,
            }}
            tone="blue"
          />
        </div>
      </ComponentCard>
      <ComponentCard
        title="Dropdown Menu · Context Menu"
        tag="right-click + chevron"
      >
        <div className="grid-2">
          <div className="mock-bg mock-bg--menu">
            <span className="mock-label">Dropdown</span>
            <Menu label="Match actions" entries={matchActions} />
          </div>
          <div className="mock-bg mock-bg--menu">
            <span className="mock-label">Context (right-click)</span>
            <Menu label="Bracket" entries={bracketActions} />
          </div>
        </div>
      </ComponentCard>
      <ComponentCard title="Command" tag="cmd+k palette">
        <div className="mock-bg mock-bg--command">
          <span className="mock-label">Command (⌘K)</span>
          <Command
            label="Command"
            placeholder="Type a command or search…"
            groups={commands}
          />
        </div>
      </ComponentCard>
    </Section>
  )
}
