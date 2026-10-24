import { Accordion, type AccordionItem } from '../components/Accordion'
import { AspectRatio } from '../components/AspectRatio'
import { Avatar, type AvatarTone } from '../components/Avatar'
import { AvatarGroup } from '../components/AvatarGroup'
import { Badge } from '../components/Badge'
import { Breadcrumb } from '../components/Breadcrumb'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Checkbox } from '../components/Checkbox'
import { Combobox, type ComboboxOption } from '../components/Combobox'
import { ComponentCard } from '../components/ComponentCard'
import { DatePicker } from '../components/DatePicker'
import { Dialog } from '../components/Dialog'
import { Field, FieldHelp, Label } from '../components/Field'
import { Input } from '../components/Input'
import { Menu, type MenuEntry } from '../components/Menu'
import { Menubar } from '../components/Menubar'
import {
  type NavigationMenuLink,
  NavigationMenuPanel,
} from '../components/NavigationMenuPanel'
import { OtpInput } from '../components/OtpInput'
import { PageHeader } from '../components/PageHeader'
import { PageIntro } from '../components/PageIntro'
import { PlayerHoverCard } from '../components/PlayerHoverCard'
import { Pagination } from '../components/Pagination'
import { Progress } from '../components/Progress'
import { Radio, RadioGroup } from '../components/RadioGroup'
import { RatingDelta } from '../components/RatingDelta'
import { Section } from '../components/Section'
import { Select } from '../components/Select'
import { Skeleton } from '../components/Skeleton'
import { Slider } from '../components/Slider'
import { Switch } from '../components/Switch'
import { type Column, Table } from '../components/Table'
import { type Tab, Tabs } from '../components/Tabs'
import { Textarea } from '../components/Textarea'
import { Tooltip } from '../components/Tooltip'
import { Toggle } from '../components/Toggle'
import { ToggleGroup, ToggleGroupItem } from '../components/ToggleGroup'
import { plainDate } from '../components/plainDate'

// The Combobox card's players. The reference shows the three that "ngu"
// matches; the rest are there for it to filter out.
const players: ComboboxOption[] = [
  { id: 'tien-nguyen', label: 'Nguyen, Tien', hint: '1620' },
  { id: 'mai-nguyen', label: 'Nguyen, Mai', hint: '1455' },
  { id: 'phuc-nguyen', label: 'Nguyen, Phuc', hint: '1380' },
  { id: 'ana-silva', label: 'Silva, Ana', hint: '1710' },
  { id: 'kenji-tanaka', label: 'Tanaka, Kenji', hint: '1540' },
  { id: 'lena-weber', label: 'Weber, Lena', hint: '1295' },
]

// The Tabs card's tabs. The reference shows only the overview's panel.
const tournamentTabs: Tab[] = [
  {
    value: 'overview',
    label: 'Overview',
    panel:
      'Tournament overview — 32 players, 4 courts, finals projected for 6:45pm.',
  },
  {
    value: 'schedule',
    label: 'Schedule',
    panel: 'Round 3 starts at 2:00pm — 16 matches across 4 courts.',
  },
  {
    value: 'standings',
    label: 'Standings',
    panel: 'Group A after round 2 — Nguyen and Okafor lead on 2 wins each.',
  },
  {
    value: 'players',
    label: 'Players',
    panel: '32 players from 9 clubs, rated 1180 to 1720.',
  },
]

// The Accordion card's questions. The reference shows only the first's
// answer.
const faq: AccordionItem[] = [
  {
    value: 'scheduler',
    title: 'How does the SMT scheduler work?',
    content:
      'It treats every match as a constraint and solves for an assignment that minimizes back-to-backs, balances court usage, and respects player breaks.',
  },
  {
    value: 'free',
    title: 'Is FortyMM really free?',
    content:
      'Yes. Running a tournament, scoring it live and sharing its brackets cost nothing.',
  },
  {
    value: 'ratings',
    title: 'How do ratings update?',
    content:
      'After every rated match. An upset moves both ratings further than an expected result.',
  },
]

// The Navigation Menu card's links. There are no such pages yet, so they go
// back to the Navigation section.
const productLinks: NavigationMenuLink[] = [
  {
    title: 'Match recorder',
    description: 'Track scores in real time, no internet needed.',
    href: '#nav',
  },
  {
    title: 'Tournament admin',
    description: 'SMT-solved draws and live scoring.',
    href: '#nav',
  },
  {
    title: 'Spectator brackets',
    description: 'Shareable, public, branded.',
    href: '#nav',
  },
  {
    title: 'Club tools',
    description: 'Member rosters, ladder leagues.',
    href: '#nav',
  },
]

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

type Standing = {
  // First name first, as Avatar takes it. The table shows it last name first.
  name: string
  tone: AvatarTone
  club: string
  rating: number
  wins: number
  losses: number
  delta: number
}

const standings: Standing[] = [
  {
    name: 'Tien Nguyen',
    tone: 'neutral',
    club: 'Brooklyn TT',
    rating: 1620,
    wins: 14,
    losses: 3,
    delta: 18,
  },
  {
    name: 'Daniel Okafor',
    tone: 'red',
    club: 'NYC Open Hall',
    rating: 1582,
    wins: 11,
    losses: 4,
    delta: 12,
  },
  {
    name: 'Marta Kowalski',
    tone: 'green',
    club: 'Brooklyn TT',
    rating: 1505,
    wins: 8,
    losses: 6,
    delta: -4,
  },
]

function lastNameFirst(name: string): string {
  const [first, ...rest] = name.split(' ')
  return `${rest.join(' ')}, ${first}`
}

const standingColumns: Column<Standing>[] = [
  {
    header: 'Player',
    cell: (standing) => (
      <span className="row player-cell">
        <Avatar name={standing.name} size="sm" tone={standing.tone} />
        {lastNameFirst(standing.name)}
      </span>
    ),
  },
  { header: 'Club', cell: (standing) => standing.club },
  { header: 'Rating', numeric: true, cell: (standing) => standing.rating },
  {
    header: 'W-L',
    numeric: true,
    cell: (standing) => `${standing.wins}–${standing.losses}`,
  },
  {
    header: 'Δ',
    numeric: true,
    cell: (standing) => <RatingDelta value={standing.delta} />,
  },
]

export function DesignSystem() {
  return (
    <>
      <PageHeader title="Design System" subtitle="FortyMM · tokens · components" />
      <PageIntro>
        Every FortyMM component, styled with the design system's tokens. Use
        this page as your visual reference: if a component looks different
        here, it looks different in the app.
      </PageIntro>
      <Section
        id="forms"
        title="Forms & Input"
        lead={
          <>
            Buttons, inputs, selectors. The interactive surface of every form.
            Hero color (<code>--ball-500</code>) is reserved for the single
            primary action per screen.
          </>
        }
      >
        <ComponentCard title="Button" tag="7 variants · 4 sizes">
          <div className="col">
            <div className="row">
              <Button>Log a match</Button>
              <Button variant="secondary">Save draft</Button>
              <Button variant="outline">Cancel</Button>
              <Button variant="ghost">Skip</Button>
              <Button variant="destructive">Forfeit match</Button>
              <Button variant="link">Read manifesto</Button>
              <Button disabled>Disabled</Button>
            </div>
            <div className="row">
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
              <Button size="icon" aria-label="Add">
                +
              </Button>
            </div>
          </div>
        </ComponentCard>
        <ComponentCard title="Input · Label · Form Field" tag="composite">
          <div className="grid-2">
            <Field>
              <Label>Player tag</Label>
              <Input placeholder="@yourname" defaultValue="@nguyen.t" />
              <FieldHelp>Visible to opponents in match invites.</FieldHelp>
            </Field>
            <Field required invalid>
              <Label>Email</Label>
              <Input defaultValue="not-an-email" />
              <FieldHelp>Enter a valid email address.</FieldHelp>
            </Field>
            <Field disabled>
              <Label>Disabled</Label>
              <Input defaultValue="Locked field" />
            </Field>
            <Field>
              <Label>Search</Label>
              <Input placeholder="Search clubs, players, tournaments…" />
            </Field>
          </div>
        </ComponentCard>
        <ComponentCard title="Textarea" tag="resizable">
          <Field>
            <Label>Match notes</Label>
            <Textarea
              placeholder="Add context — venue, conditions, anything memorable."
              defaultValue="Played in the back hall. Andrew's forehand was on fire today — three straight games to 11."
            />
          </Field>
        </ComponentCard>
        <ComponentCard title="Input OTP" tag="6-digit">
          {/* The reference shows no label, so this one is only for screen
              readers. The fourth cell is shown active, as in the reference,
              until the input is focused. */}
          <Field>
            <Label className="visually-hidden">Verification code</Label>
            <OtpInput defaultValue="40MM" activeIndex={3} />
          </Field>
        </ComponentCard>
        <ComponentCard title="Checkbox" tag="3 states">
          <div className="col">
            <Checkbox defaultChecked>I agree to the rules of fair play</Checkbox>
            <Checkbox>Email me match invites</Checkbox>
            <Checkbox disabled>Disabled option</Checkbox>
          </div>
        </ComponentCard>
        <ComponentCard title="Radio Group" tag="single-select">
          {/* The reference shows no group label, so this one is only for
              screen readers. */}
          <Field>
            <Label className="visually-hidden">Match format</Label>
            <RadioGroup defaultValue="singles-5">
              <Radio value="singles-5">Singles · best of 5</Radio>
              <Radio value="singles-7">Singles · best of 7</Radio>
              <Radio value="doubles-5">Doubles · best of 5</Radio>
            </RadioGroup>
          </Field>
        </ComponentCard>
        <ComponentCard title="Switch" tag="on/off">
          <div className="col">
            <Switch defaultChecked>Public profile</Switch>
            <Switch>Notify me of nearby matches</Switch>
          </div>
        </ComponentCard>
        <ComponentCard title="Slider" tag="single + range">
          {/* The reference's two sliders don't share a scale, so each has
              one that puts its thumbs where the reference draws them. */}
          <div className="col slider-demo">
            <Slider min={1070} max={2070} step={10} defaultValue={1620}>
              Skill level
            </Slider>
            <Slider min={1100} max={2100} step={10} defaultValue={[1400, 1800]}>
              Rating range
            </Slider>
          </div>
        </ComponentCard>
        <ComponentCard title="Select" tag="native">
          {/* The reference shows no labels, so an aria-label names each
              select. A Field's hidden Label would wrap each in a
              .form-field, which would be the row's item instead. */}
          <div className="row">
            <Select aria-label="Match type">
              <option>Singles</option>
              <option>Doubles</option>
            </Select>
            <Select aria-label="Match length" className="select-wide">
              <option>Best of 5 games</option>
            </Select>
          </div>
        </ComponentCard>
        <ComponentCard title="Combobox" tag="searchable select · open">
          {/* The reference shows no label, so an aria-label names the
              combobox. It opens on "ngu", as the reference draws it. */}
          <Combobox
            aria-label="Find a player"
            placeholder="Find a player…"
            options={players}
            defaultQuery="ngu"
            defaultOpen
            className="combobox-demo"
          />
        </ComponentCard>
        <ComponentCard title="Date Picker" tag="calendar in popover">
          {/* Open on the reference's chosen day, with the calendar beside
              the button rather than over the page, as the reference draws
              it. Today comes from the clock. */}
          <Field>
            <DatePicker
              label={<Label>Match date</Label>}
              defaultValue={plainDate(2026, 4, 12)}
              defaultOpen
              className="date-picker-demo"
            />
          </Field>
        </ComponentCard>
        <ComponentCard title="Toggle · Toggle Group" tag="single + multi">
          {/* The reference shows no labels. B and I are symbols, so an
              aria-label names each toggle by what it does, and one names
              the group. */}
          <div className="row">
            <Toggle aria-label="Bold" defaultPressed>
              B
            </Toggle>
            <Toggle aria-label="Italic">I</Toggle>
            <span className="sep-v" role="separator" aria-orientation="vertical" />
            <ToggleGroup aria-label="Match type" defaultValue="singles">
              <ToggleGroupItem value="singles">Singles</ToggleGroupItem>
              <ToggleGroupItem value="doubles">Doubles</ToggleGroupItem>
              <ToggleGroupItem value="mixed">Mixed</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </ComponentCard>
      </Section>
      <Section
        id="display"
        title="Data Display"
        lead={
          <>
            Cards, tables, badges, avatars. The product is ratings and
            rankings — these components are where the numbers live.
          </>
        }
      >
        <ComponentCard title="Card" tag="container">
          <div className="grid-2">
            <Card
              headingLevel={4}
              title="April Spring Open"
              description="Hosted by Brooklyn TT Club"
              footer={
                <>
                  <Button size="sm">Register</Button>
                  <Button size="sm" variant="outline">
                    View draw
                  </Button>
                </>
              }
            >
              32 players, single-elimination, 4 courts. Scheduling
              auto-generated by SMT solver.
            </Card>
            <Card
              headingLevel={4}
              variant="featured"
              title="★ Featured"
              description="National Championships qualifier"
              footer={<Button size="sm">Apply</Button>}
            >
              Top 8 advance to the regional bracket. Limited to USATT members.
            </Card>
          </div>
        </ComponentCard>
        <ComponentCard title="Badge" tag="5 variants">
          <div className="row">
            <Badge>Seed 1</Badge>
            <Badge variant="secondary">Doubles</Badge>
            <Badge variant="outline">Pending</Badge>
            <Badge variant="destructive">Disqualified</Badge>
            <Badge variant="live">Live · Court 3</Badge>
          </div>
        </ComponentCard>
        <ComponentCard title="Avatar" tag="image · initials · stack">
          <div className="row avatar-demo">
            <div className="row">
              <Avatar name="Tien Nguyen" size="sm" />
              <Avatar name="Daniel Okafor" />
              <Avatar name="Marta Kowalski" size="lg" tone="brand" />
            </div>
            <AvatarGroup label="Players" overflow={12}>
              <Avatar name="Tien Nguyen" tone="blue" />
              <Avatar name="Daniel Okafor" tone="red" />
              <Avatar name="Marta Kowalski" tone="green" />
            </AvatarGroup>
          </div>
        </ComponentCard>
        <ComponentCard title="Table · Data Table" tag="sortable rows">
          <Table
            label="Standings"
            columns={standingColumns}
            rows={standings}
            rowKey={(standing) => standing.name}
          />
        </ComponentCard>
        <ComponentCard title="Progress" tag="determinate">
          <div className="col progress-demo">
            <Progress
              label="Round 1 of 5"
              value={12}
              max={16}
              format="fraction"
            />
            <Progress label="Group B" value={25} max={100} format="percent" />
          </div>
        </ComponentCard>
        <ComponentCard title="Skeleton" tag="loading state">
          <div className="row skeleton-demo">
            <Skeleton shape="circle" width={48} height={48} />
            <div className="col skeleton-lines">
              <Skeleton width="60%" height={14} />
              <Skeleton width="40%" height={12} />
            </div>
          </div>
        </ComponentCard>
        {/* The kit's tag names a 4:3 box it doesn't show. */}
        <ComponentCard title="Aspect Ratio" tag="16:9 · 4:3 · 1:1">
          <div className="grid-2 aspect-ratio-demo">
            <AspectRatio ratio={16 / 9}>16 : 9</AspectRatio>
            <AspectRatio ratio={1}>1 : 1</AspectRatio>
          </div>
        </ComponentCard>
      </Section>
      <Section
        id="nav"
        title="Navigation"
        lead="Tabs, breadcrumbs, pagination, menus. Wayfinding inside the app."
      >
        {/* The kit's tag names an underlined style it doesn't show. */}
        <ComponentCard title="Tabs" tag="underlined or boxed">
          <Tabs label="Tournament" tabs={tournamentTabs} />
        </ComponentCard>
        <ComponentCard title="Accordion" tag="collapsible FAQ">
          <div className="accordion-demo">
            <Accordion
              items={faq}
              defaultOpen={faq[0].value}
              headingLevel={4}
            />
          </div>
        </ComponentCard>
        {/* There are no such pages yet, so the links go back to this section. */}
        <ComponentCard title="Breadcrumb" tag="trail">
          <Breadcrumb
            items={[
              { label: 'Tournaments', href: '#nav' },
              { label: 'April Spring Open', href: '#nav' },
              { label: 'Round 3' },
            ]}
          />
        </ComponentCard>
        <ComponentCard title="Pagination" tag="paged tables">
          <Pagination pageCount={12} />
        </ComponentCard>
        {/* As the kit does, this shows only the panel that hovering Product
            opens. */}
        <ComponentCard title="Navigation Menu" tag="mega-dropdown">
          <div className="mock-bg mock-bg--fit">
            <span className="mock-label">Hovered: Product</span>
            <NavigationMenuPanel label="Product" items={productLinks} />
          </div>
        </ComponentCard>
        {/* File shows active, as in the reference. Its menu isn't shown. */}
        <ComponentCard title="Menubar" tag="desktop app">
          <Menubar
            label="App"
            items={['File', 'Edit', 'View', 'Tournament', 'Help']}
            activeIndex={0}
          />
        </ComponentCard>
      </Section>
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
      </Section>
    </>
  )
}
