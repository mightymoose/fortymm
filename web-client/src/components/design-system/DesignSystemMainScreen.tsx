import { Link } from '@tanstack/react-router'
import { Icon } from '../../design-system/Icon.tsx'
import './showcase.css'
import { RadiusTile } from './RadiusTile.tsx'
import { ShadowTile } from './ShadowTile.tsx'
import { ShowcaseExample } from './ShowcaseExample.tsx'
import { SpacingRow } from './SpacingRow.tsx'
import { Swatch } from './Swatch.tsx'
import { SwatchGrid } from './SwatchGrid.tsx'
import { TypeRow } from './TypeRow.tsx'

// The design system's main board (requirements/design-system/reference/Main.dc.html): the showcase
// title, the links to every board, and the Foundations section. Text is copied from the board.
export function DesignSystemMainScreen() {
  return (
    <main className="doc" data-testid="page-foundations">
      <header className="doc-head">
        <h1>FortyMM component showcase</h1>
        <p>
          Reference page for screenshot tests. Every component in the v2.1 library, in its
          documented states, built from the shared tokens and <code>fm-*</code> classes. Test ids
          match the component gallery, so the same Playwright selectors work against the app.
        </p>
        <nav className="doc-toc" aria-label="Showcase sections">
          <Link to="/design-system">Foundations</Link>
          <Link to="/design-system/roles">Roles and buttons</Link>
          <Link to="/design-system/forms">Fields and selection</Link>
          <Link to="/design-system/containers">Containers and feedback</Link>
          <Link to="/design-system/overlays">Overlays</Link>
          <Link to="/design-system/match">Match components</Link>
          <Link to="/design-system/more">More components</Link>
          <Link to="/design-system/states">State matrix</Link>
        </nav>
        <p className="fm-notice" style={{ maxWidth: 780 }}>
          <Icon name="info" />
          <span>
            Everything here is <b>visual only</b>. Overlays, open menus and forced hover, focus and
            pressed states are drawn in place so each one can be captured without interaction.
          </span>
        </p>
      </header>
      <section className="doc-cat" data-testid="section-foundations">
        <h2>Foundations</h2>
        <p>
          Dark only, flat surfaces. Orange marks actions and selection; every status has its own
          hue and a non-colour cue.
        </p>
        <ShowcaseExample
          testId="found-colour-surfaces"
          title="Surfaces"
          description="Ink scale. Page on ink-950, grouped content on ink-900, hover on ink-700. Most screens use two surfaces."
        >
          <SwatchGrid>
            <Swatch color="--ink-950" name="ink-950 · bg-app" value="#0B0D12" />
            <Swatch color="--ink-900" name="ink-900 · bg-panel" value="#11141B" />
            <Swatch color="--ink-800" name="ink-800 · bg-group" value="#171B24" />
            <Swatch color="--ink-700" name="ink-700 · bg-hover" value="#1F2430" />
            <Swatch color="--ink-600" name="ink-600 · border-subtle" value="#2A3040" />
            <Swatch color="--ink-500" name="ink-500 · border-control" value="#3A4152" />
            <Swatch color="--ink-400" name="ink-400 · fg-disabled" value="#535B6E" />
          </SwatchGrid>
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-colour-text"
          title="Text and edges"
          description="All text tokens pass 4.5:1 on ink-950. Field edges (3:1) are brighter than dividers."
        >
          <SwatchGrid>
            <Swatch color="--chalk-50" name="chalk-50 · fg-1" value="#F7F8FB" />
            <Swatch color="--chalk-100" name="chalk-100 · fg-2" value="#E4E7EF" />
            <Swatch color="--chalk-300" name="chalk-300 · fg-3" value="#A9B0C2" />
            <Swatch color="--chalk-500" name="chalk-500 · placeholder" value="#7C8396" />
            <Swatch color="--border-field" name="border-field" value="#6B7389" />
          </SwatchGrid>
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-colour-accent"
          title="Accent"
          description="Ball orange. Primary buttons, focus ring, links, and selected tabs, chips and nav. Nothing else."
        >
          <SwatchGrid>
            <Swatch color="--ball-200" name="ball-200 · accent-text" value="#FFCFA8" />
            <Swatch color="--ball-400" name="ball-400 · hover, links" value="#FF9A4A" />
            <Swatch color="--ball-500" name="ball-500 · accent" value="#FF7A1A" />
            <Swatch color="--ball-600" name="ball-600 · pressed" value="#E85E00" />
            <Swatch color="--accent-soft" name="accent-soft" value="14% ball-500" />
          </SwatchGrid>
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-colour-status"
          title="Status"
          description="Each state has one hue and never borrows orange."
        >
          <SwatchGrid>
            <Swatch color="--live" name="live" value="#F2496B" />
            <Swatch color="--serving" name="serving, winner" value="#F7F8FB" />
            <Swatch color="--rating-up" name="rating-up, success" value="#3DD68C" />
            <Swatch color="--rating-down" name="rating-down, loser" value="#A9B0C2" />
            <Swatch color="--conflict" name="conflict" value="#F5C542" />
            <Swatch color="--rest" name="rest" value="#7AB8FF" />
            <Swatch color="--danger" name="danger" value="#FF6B6B" />
          </SwatchGrid>
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-type"
          title="Type"
          description="Space Grotesk for every word in the UI. JetBrains Mono, tabular, for numbers that align. Bebas Neue only for the wordmark and venue scoreboards. Sentence case, 12px minimum."
          stageStyle={{ gap: 0 }}
        >
          <TypeRow label="h1 · 48 / 700">
            <div className="h1">Spring Open 2026</div>
          </TypeRow>
          <TypeRow label="h2 · 32 / 600">
            <div className="h2">Round of 16</div>
          </TypeRow>
          <TypeRow label="h3 · 20 / 600">
            <div className="h3">Your next match</div>
          </TypeRow>
          <TypeRow label="text-md · 17 / 500">
            <div style={{ font: '500 17px/1.3 var(--font-ui)', color: 'var(--fg-1)' }}>
              Okafor-Adeyemi, Daniel
            </div>
          </TypeRow>
          <TypeRow label="body · 15 / 400">
            <div className="body">
              Round of 16 starts on all four tables once the last Round of 32 match finishes.
            </div>
          </TypeRow>
          <TypeRow label="label · 13 / 500">
            <div className="label">Minimum rest between matches</div>
          </TypeRow>
          <TypeRow label="meta · 13 / 400">
            <div className="meta">Table 3 · Round of 32 · Game 5</div>
          </TypeRow>
          <TypeRow label="num · mono tabular">
            <div className="num" style={{ fontSize: 15, color: 'var(--fg-1)' }}>
              2,145 · 1,987 · 11:47 · 11–9
            </div>
          </TypeRow>
          <TypeRow label="score · 96 / 700 mono">
            <div className="score">11</div>
          </TypeRow>
          <TypeRow label="scoreboard-display · 48">
            <div className="scoreboard-display" style={{ color: 'var(--fg-1)' }}>
              OKAFOR-ADEYEMI
            </div>
          </TypeRow>
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-spacing"
          title="Spacing"
          description="4px scale. 8–12 within a row, 16–24 between groups, 48–64 between page sections."
          stageStyle={{ gap: 10 }}
        >
          <SpacingRow token="s-1" size={4} />
          <SpacingRow token="s-2" size={8} />
          <SpacingRow token="s-3" size={12} />
          <SpacingRow token="s-4" size={16} />
          <SpacingRow token="s-5" size={20} />
          <SpacingRow token="s-6" size={24} />
          <SpacingRow token="s-8" size={32} />
          <SpacingRow token="s-12" size={48} />
          <SpacingRow token="s-16" size={64} />
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-radii-shadows"
          title="Radii, shadows and focus"
          description="6 chips and inputs, 8 buttons and cards, 12 sheets and dialogs, pill for filter chips only. Shadows only on overlays. Focus is always the 2px orange ring with a dark gap."
        >
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <RadiusTile token="r-sm" label="r-sm · 6" height={80} />
            <RadiusTile token="r-md" label="r-md · 8" height={80} />
            <RadiusTile token="r-lg" label="r-lg · 12" height={80} />
            <RadiusTile token="r-pill" label="r-pill" height={40} />
          </div>
          <div
            style={{
              display: 'flex',
              gap: 40,
              flexWrap: 'wrap',
              alignItems: 'center',
              padding: 24,
              background: 'var(--bg-panel)',
              borderRadius: 8,
            }}
          >
            <ShadowTile token="shadow-overlay" />
            <ShadowTile token="shadow-tooltip" />
            <div className="sw" style={{ width: 160 }}>
              <button className="fm-btn fm-btn--secondary is-focus">Focus ring</button>
              <b>focus-ring</b>
            </div>
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-status-markers"
          title="Status markers"
          description="Static. A live match shows one red marker; the server gets a small white ball; rating changes are signed with an arrow."
        >
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="live-marker">Live</span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                font: '500 15px var(--font-ui)',
                color: 'var(--fg-1)',
              }}
            >
              Patel, Meera{' '}
              <span className="serve-marker" role="img" aria-label="Serving"></span>
            </span>
            <span className="rating-up">▲ +12</span>
            <span className="rating-down">▼ −8</span>
            <span className="fm-rest">
              <Icon name="clock" />
              Rest until <span className="num">19:35</span>
            </span>
            <span className="fm-status fm-status--conflict">
              <Icon name="triangle-alert" />
              Needs decision
            </span>
            <span className="fm-status fm-status--offline">Scorer offline</span>
          </div>
        </ShowcaseExample>
        <ShowcaseExample
          testId="found-icons"
          title="Icons"
          description="Lucide, stroke 1.75, 20px (16px in dense rows). No emoji."
        >
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', color: 'var(--fg-2)' }}>
            <Icon name="info" label="Info" />
            <Icon name="clock" label="Clock" />
            <Icon name="check" label="Check" />
            <Icon name="triangle-alert" label="Alert" />
            <Icon name="circle-alert" label="Error" />
            <Icon name="wifi-off" label="Offline" />
            <Icon name="calendar" label="Calendar" />
            <Icon name="undo-2" label="Undo" />
            <Icon name="list" label="List" />
            <Icon name="table" label="Table" />
            <Icon name="search" label="Search" />
            <Icon name="ellipsis" label="More" />
            <Icon name="x" label="Close" />
            <Icon name="chevron-down" label="Chevron down" />
            <Icon name="chevron-left" label="Previous" />
            <Icon name="chevron-right" label="Next" />
          </div>
        </ShowcaseExample>
      </section>
    </main>
  )
}
