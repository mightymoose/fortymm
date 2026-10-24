import { Accordion, type AccordionItem } from '../../components/Accordion'
import { Breadcrumb } from '../../components/Breadcrumb'
import { ComponentCard } from '../../components/ComponentCard'
import { Menubar } from '../../components/Menubar'
import {
  type NavigationMenuLink,
  NavigationMenuPanel,
} from '../../components/NavigationMenuPanel'
import { Pagination } from '../../components/Pagination'
import { Section } from '../../components/Section'
import { type Tab, Tabs } from '../../components/Tabs'

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

export function NavigationSection() {
  return (
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
  )
}
