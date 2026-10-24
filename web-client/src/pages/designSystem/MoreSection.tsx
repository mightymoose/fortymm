import { useState } from 'react'
import { Carousel } from '../../components/Carousel'
import { Menubar, type MenubarMenu } from '../../components/Menubar'
import { Meter } from '../../components/Meter'
import { RatingChange } from '../../components/RatingChange'
import { Example, GallerySection } from './GallerySection'
import { findMatch, type FinalMatch } from './match'
import { MatchRow } from './MatchRow'

type RatedPlayer = {
  name: string
  club: string
  played: number
  rating: number
  change: number
}

// The Data table example's players.
const ratedPlayers: readonly RatedPlayer[] = [
  { name: 'Nguyen, Thanh', club: 'Riverside TT', played: 42, rating: 2145, change: 12 },
  { name: 'Wójcik-Szymańska, Agnieszka', club: 'Northside', played: 37, rating: 2088, change: 4 },
  { name: 'Okafor-Adeyemi, Daniel', club: 'Eastgate', played: 51, rating: 1987, change: -12 },
]

const thousands = new Intl.NumberFormat('en-US')

// The Menubar example's menus.
const tournamentTools: readonly MenubarMenu[] = [
  {
    label: 'Tournament',
    items: [
      { label: 'Edit details' },
      { label: 'Venue and tables' },
      { label: 'Print entry list', shortcut: '⌘P' },
    ],
  },
  {
    label: 'Schedule',
    items: [
      { label: 'Add a break' },
      { label: 'Re-plan from now' },
      { label: 'Change minimum rest' },
    ],
  },
  {
    label: 'Results',
    items: [
      { label: 'Export results (CSV)' },
      { label: 'Publish to spectators' },
      'divider',
      { label: 'Clear all results…', danger: true },
    ],
  },
]

function finishedMatch(id: string): FinalMatch {
  const match = findMatch(id)
  if (match.state !== 'final') throw new Error(`Match "${id}" isn't finished`)
  return match
}

// The Carousel example's finished matches: three from the sample day, then
// two from before it.
const finishedMatches: readonly FinalMatch[] = [
  ...['a1', 'b1', 'c1'].map(finishedMatch),
  { id: 'x1', table: 2, state: 'final', start: '09:45', end: '10:20', event: 'Open singles', round: 'Round of 64', players: [{ name: 'Patel, Meera' }, { name: 'Dubois, Camille' }], games: [[11, 6], [11, 9], [8, 11], [11, 7]] },
  { id: 'x2', table: 4, state: 'final', start: '09:45', end: '10:25', event: 'Under 18 singles', round: 'Round of 16', players: [{ name: 'Haddad, Youssef' }, { name: 'Ali, Rashid' }], games: [[9, 11], [11, 7], [11, 13], [11, 9], [11, 8]] },
]

// The Menubar example: choosing a command only says which one, as the
// gallery's does.
function TournamentTools() {
  const [chosen, setChosen] = useState<string | null>(null)
  return (
    <>
      <Menubar
        label="Tournament tools"
        menus={tournamentTools}
        onChoose={(menu, command) =>
          // The gallery reads the command's whole text, its shortcut too.
          setChosen(`${menu.label} → ${command.label}${command.shortcut ?? ''}`)
        }
      />
      <p className="fm-help" aria-live="polite">
        {chosen
          ? `Chose ${chosen}. (Demo: nothing else happens.)`
          : 'Demo: choosing a command only shows its name here.'}
      </p>
    </>
  )
}

// The design system page's More components section: the reference gallery's
// `section-more`, with its Data table, Tags, avatar, progress, Navigation,
// Menubar, Carousel and Accordion examples. Its links go to the section
// itself, as the gallery's do, because the pages they name don't exist.
export function MoreSection() {
  return (
    <GallerySection id="more" title="More components">
      <Example
        testId="ex-data-table"
        title="Data table"
        description="Mono, right-aligned numbers; signed rating changes. Only the header has a strong rule."
        stageClassName="fm-scroll"
      >
        <table className="fm-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Club</th>
              <th className="n">Played</th>
              <th className="n">Rating</th>
              <th className="n">Change</th>
            </tr>
          </thead>
          <tbody>
            {ratedPlayers.map((player) => (
              <tr key={player.name}>
                <td style={{ color: 'var(--fg-1)' }}>{player.name}</td>
                <td>{player.club}</td>
                <td className="n">{player.played}</td>
                <td className="n">{thousands.format(player.rating)}</td>
                <td className="n">
                  <RatingChange change={player.change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Example>
      <Example testId="ex-tags-avatar-progress" title="Tags, avatar, progress">
        <div className="doc-row">
          <span className="fm-tag">Singles</span>
          <span className="fm-tag fm-tag--outline">Seed 4</span>
          <span className="fm-avatar">TN</span>
          <span className="fm-avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
            MP
          </span>
        </div>
        <div className="fm-field" style={{ maxWidth: 420 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }} className="fm-label">
            <span>Round of 16</span>
            <span className="num">5 of 8 played</span>
          </div>
          <Meter label="Round of 16 progress" value={5} max={8} />
        </div>
      </Example>
      <Example testId="ex-navigation" title="Navigation">
        <nav className="fm-crumbs" aria-label="Breadcrumb">
          <a href="#more">Spring Open</a>
          <span aria-hidden="true">/</span>
          <a href="#more">Open singles</a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Round of 16</span>
        </nav>
        <nav className="fm-nav" aria-label="Admin">
          <a href="#more" aria-current="page">
            Tables &amp; schedule
          </a>
          <a href="#more">Draws</a>
          <a href="#more">Players</a>
          <a href="#more">Results</a>
        </nav>
        <nav className="fm-pages" aria-label="Results pages">
          <button type="button" aria-label="Previous page">
            ‹
          </button>
          <button type="button" aria-current="page">
            1
          </button>
          <button type="button">2</button>
          <button type="button">3</button>
          <span className="fm-help">…</span>
          <button type="button">12</button>
          <button type="button" aria-label="Next page">
            ›
          </button>
        </nav>
      </Example>
      <Example
        testId="ex-menubar"
        title="Menubar"
        description="Dense organizer tools on desktop only; phones use the tab bar. ← → move between menus, ↓ or Enter opens, ↑ ↓ inside, Esc closes."
      >
        <TournamentTools />
      </Example>
      <Example
        testId="ex-carousel"
        title="Carousel"
        description="Only for a short row of peers worth browsing — here, finished matches. Never auto-advances. Buttons step one card; the row also scrolls by touch or trackpad."
      >
        <Carousel
          title="Finished this morning"
          previousLabel="Previous results"
          nextLabel="Next results"
          trackLabel="Finished matches, scroll sideways"
          items={finishedMatches}
          slides={(match, slide) => (
            <article className="fm-card" {...slide}>
              <div className="fm-card__body" style={{ gap: 4 }}>
                <MatchRow match={match} />
                <p className="fm-match__scores" style={{ margin: 0 }}>
                  {match.games.map((game) => game.join('–')).join(', ')}
                </p>
              </div>
            </article>
          )}
        />
      </Example>
      <Example testId="ex-accordion" title="Accordion">
        <div>
          <details className="fm-disclosure" open>
            <summary>How are matches scheduled?</summary>
            <p>
              FortyMM fits every match onto your tables while keeping each player's rest time,
              then re-plans when a match runs long.
            </p>
          </details>
          <details className="fm-disclosure">
            <summary>Scheduling details</summary>
            <p className="num" style={{ fontSize: 13, color: 'var(--fg-3)' }}>
              1,248 variables · 12 rules · solved in 234 ms
            </p>
          </details>
        </div>
      </Example>
    </GallerySection>
  )
}
