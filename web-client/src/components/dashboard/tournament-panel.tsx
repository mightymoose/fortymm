import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Overline } from '@/components/overline'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TournamentMatchCard } from './tournament-panel/tournament-match-card'
import { TournamentPathList } from './tournament-panel/tournament-path-list'
import { TournamentStatsStrip } from './tournament-panel/tournament-stats-strip'
import type { TournamentPanelView } from './tournament-panel-view'

export interface TournamentPanelProps {
  view: TournamentPanelView
}

/**
 * The panel that tops the dashboard while the viewer is playing in a live
 * tournament: the tournament's name and venue, a tab per event they entered,
 * and inside each tab the one match to look at, where they stand, and their
 * remaining schedule.
 *
 * It sits above the attention panel deliberately. During a tournament the match
 * in front of you outranks every other to-do on the dashboard, and a player at a
 * table should not have to scroll for it.
 *
 * Pure view-in — every label, ordinal and route is decided by
 * `projectTournamentPanelView`. Tabs are the design-system `Tabs`, which brings
 * the roving-tabindex `tablist`/`tab`/`tabpanel` wiring and arrow-key
 * activation with it rather than re-implementing them here.
 */
export const TournamentPanel = ({ view }: TournamentPanelProps) => {
  const headingId = useId()
  // Uncontrolled would be simpler, but the tab set can change under us as a
  // match finishes and the dashboard refetches; keying off the event id keeps
  // the viewer on the event they chose.
  const [active, setActive] = useState(view.tabs[0].eventId)
  const current =
    view.tabs.find((tab) => tab.eventId === active) ?? view.tabs[0]
  return (
    // The design-system `Card` IS the content-panel primitive (web-client
    // CLAUDE.md), and `asChild` exists so it can be the `<section
    // aria-labelledby>` landmark rather than wrapping one — the same shape
    // `AttentionPanel` beneath it uses.
    <Card
      asChild
      className="mb-6 gap-0 bg-[color:var(--bg-panel)] p-5 sm:p-6"
      data-testid="dashboard-tournament-panel"
    >
    <section aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <Overline className="mb-1.5 text-[color:var(--ball-500)]">
            Your tournament
          </Overline>
          <h2
            id={headingId}
            // The display face, set inline the way the rest of the theme's
            // display headings do it (`app-shell__wordmark`,
            // `sys-health__headline`). The `font-display` *class* is not enough
            // on its own here: its `text-transform` lands but its `font-family`
            // loses to the inherited UI face, so the heading silently renders in
            // Space Grotesk — measured in the browser, not assumed.
            style={{ fontFamily: 'var(--font-display)' }}
            className="text-[26px] leading-none tracking-[0.02em] uppercase sm:text-[30px]"
          >
            {view.name}
          </h2>
          <p className="mt-1.5 text-[13px] text-[color:var(--fg-3)]">
            {view.subtitle}
          </p>
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-3.5">
          {view.liveLabel !== null && (
            <span className="inline-flex items-center gap-2 rounded-full bg-[color:var(--bg-live-soft)] px-3 py-1.5 font-mono text-[12px] font-semibold tracking-wider text-[color:var(--serve-500)]">
              <span
                className="size-2 animate-pulse rounded-full bg-[color:var(--serve-500)]"
                aria-hidden="true"
              />
              {view.liveLabel}
            </span>
          )}
          <Link
            to="/tournaments/$tournamentId"
            params={{ tournamentId: view.tournamentId }}
            className="inline-flex items-center gap-1.5 text-[14px] font-semibold whitespace-nowrap text-[color:var(--ball-500)] hover:text-[color:var(--ball-400)]"
          >
            {view.destinationLabel}
            <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <Tabs
        value={current.eventId}
        onValueChange={setActive}
        className="mt-4 gap-0"
      >
        <TabsList
          variant="line"
          aria-label="Your events"
          className="w-full justify-start overflow-x-auto border-b border-[color:var(--border-subtle)] pb-1"
        >
          {view.tabs.map((tab) => (
            <TabsTrigger
              key={tab.eventId}
              value={tab.eventId}
              className="flex-none gap-2 px-4 py-2.5 text-[14px]"
            >
              {tab.name}
              {tab.live && (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-1.5 rounded-full bg-[color:var(--serve-500)] shadow-[0_0_8px_rgba(0,226,154,0.6)]"
                    aria-hidden="true"
                  />
                  <span className="text-[12px] font-bold text-[color:var(--serve-500)]">
                    Live
                  </span>
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {view.tabs.map((tab) => (
          <TabsContent
            key={tab.eventId}
            value={tab.eventId}
            className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(272px,1fr)] lg:items-start"
          >
            {tab.match === null ? (
              <p
                className="min-w-0 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-5 text-[14px] text-[color:var(--fg-3)]"
                data-testid="tournament-panel-no-match"
              >
                The draw for this event hasn&rsquo;t been made yet. Your matches
                will appear here once it is.
              </p>
            ) : (
              <TournamentMatchCard match={tab.match} />
            )}
            <div className="flex min-w-0 flex-col gap-3.5">
              <TournamentStatsStrip stats={tab.stats} />
              <TournamentPathList
                heading={tab.pathHeading}
                subheading={tab.pathSubheading}
                rows={tab.path}
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </section>
    </Card>
  )
}
