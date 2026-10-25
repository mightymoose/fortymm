import { Link } from '@tanstack/react-router'
import { useId, type CSSProperties, type ReactNode } from 'react'
import { classifyFailure } from '../../api/errors'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { initials } from '../../components/initials'
import { leagues, type League, type Player } from './samplePlayers'
import {
  detailScenarios,
  listScenarios,
  scenarioLabels,
  type DetailScenario,
  type ListScenario,
} from './scenarios'
import type { VariantSlug } from './variantSlugs'

// The bar over each mockup: a tag that says it's a mockup, then a link to
// each state the page can be in. The design system's pages never pretend,
// so the tag says the players are samples.
function MockupBar({ children }: { children: ReactNode }) {
  return (
    <aside className="mockup-bar" aria-label="Mockup">
      <span className="doc-vo">Mockup · sample players, nothing is saved</span>
      <nav className="fm-nav" aria-label="Mockup states">
        <Link to="/players" activeOptions={{ exact: true }}>
          All mockups
        </Link>
        {children}
      </nav>
    </aside>
  )
}

export function ListStatesBar({ variant }: { variant: VariantSlug }) {
  return (
    <MockupBar>
      {listScenarios.map((state: ListScenario) => (
        <Link
          key={state}
          to="/players/$variant"
          params={{ variant }}
          search={state === 'ready' ? {} : { state }}
          activeOptions={{ exact: true }}
        >
          {scenarioLabels[state]}
        </Link>
      ))}
    </MockupBar>
  )
}

export function DetailStatesBar({
  variant,
  playerId,
}: {
  variant: VariantSlug
  playerId: string
}) {
  return (
    <MockupBar>
      {detailScenarios.map((state: DetailScenario) => (
        <Link
          key={state}
          to="/players/$variant/$playerId"
          params={{ variant, playerId }}
          search={state === 'ready' ? {} : { state }}
          activeOptions={{ exact: true }}
        >
          {scenarioLabels[state]}
        </Link>
      ))}
      <Link
        to="/players/$variant/$playerId"
        params={{ variant, playerId: 'gentle-gecko-640' }}
        activeOptions={{ exact: true }}
      >
        New player
      </Link>
    </MockupBar>
  )
}

// A flat placeholder block, `.fm-skeleton`. The design system has no shimmer.
export function Bone({ w = '100%', h = '14px' }: { w?: string; h?: string }) {
  return <span className="fm-skeleton bone" style={{ '--w': w, '--h': h } as CSSProperties} />
}

// A region still loading: one status for screen readers, and the skeleton,
// hidden from them.
export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div aria-busy="true">
      <span role="status" className="fm-sr">
        {label}
      </span>
      <div aria-hidden="true">{children}</div>
    </div>
  )
}

// An alert in place of what failed to load. It reads the error as the root
// error page does, but keeps the page around it.
export function LoadFailure({
  error,
  subject,
  onRetry,
  retrying,
}: {
  error: unknown
  subject: string
  onRetry: () => void
  retrying: boolean
}) {
  const failure = classifyFailure(error)
  const retry = (
    <Button variant="secondary" size="sm" busy={retrying} onClick={onRetry}>
      {retrying ? 'Trying again…' : 'Try again'}
    </Button>
  )
  switch (failure.kind) {
    case 'unreachable':
      return (
        <div className="fm-alert fm-alert--warning" role="alert">
          <Icon name="offline" />
          <p className="fm-alert__title">Can’t reach FortyMM</p>
          <p className="fm-alert__body">
            Our server isn’t answering, so we can’t show {subject}. Check your connection,
            then try again.
          </p>
          <div className="fm-alert__actions">{retry}</div>
        </div>
      )
    case 'rate-limited':
      return (
        <div className="fm-alert fm-alert--warning" role="alert">
          <Icon name="clock" />
          <p className="fm-alert__title">Wait a minute, then try again</p>
          <p className="fm-alert__body">
            Your network sent a lot of requests in a short time, so we paused it for a
            minute.
            {failure.retryAt && (
              <>
                {' '}
                Try again at{' '}
                <span className="num">
                  {failure.retryAt.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                .
              </>
            )}
          </p>
          <div className="fm-alert__actions">{retry}</div>
        </div>
      )
    case 'broken':
      return (
        <div className="fm-alert fm-alert--error" role="alert">
          <Icon name="error" />
          <p className="fm-alert__title">We couldn’t load {subject}</p>
          <p className="fm-alert__body">
            FortyMM hit an error. Try again. If it keeps happening, tell us what you were
            doing.
          </p>
          <div className="fm-alert__actions">{retry}</div>
        </div>
      )
  }
}

// The player 404, inside the app's frame. Players are never deleted, so a
// missing one means the address is wrong. `compact` fits it in a pane.
export function PlayerNotFound({
  variant,
  compact = false,
}: {
  variant: VariantSlug
  compact?: boolean
}) {
  const titleId = useId()
  const Title = compact ? 'h2' : 'h1'
  return (
    <section className="player-missing" data-compact={compact} aria-labelledby={titleId}>
      <span className="player-missing__mark">
        <Icon name="user" />
      </span>
      <Title id={titleId}>We can’t find that player</Title>
      <p>
        No player has this address. Players stay on FortyMM for good, so the link may
        have a typo. Check it, or find the player in the list.
      </p>
      <div className="player-missing__actions">
        <Link
          to="/players/$variant"
          params={{ variant }}
          activeOptions={{ exact: true }}
          className="fm-btn fm-btn--primary"
        >
          See all players
        </Link>
        {!compact && (
          <Button variant="ghost" onClick={() => window.history.back()}>
            Go back
          </Button>
        )}
      </div>
    </section>
  )
}

export function Avatar({ player, large = false }: { player: Player; large?: boolean }) {
  return (
    <span className={large ? 'fm-avatar avatar-lg' : 'fm-avatar'} aria-hidden="true">
      {initials(player.displayName)}
    </span>
  )
}

export function KindTag({ player }: { player: Player }) {
  return (
    <span className="fm-tag fm-tag--outline">
      {player.kind === 'guest' ? 'Guest' : 'Verified'}
    </span>
  )
}

export function Record({ wins, losses }: { wins: number; losses: number }) {
  return (
    <span className="num">
      {wins}–{losses}
    </span>
  )
}

// A choice of league, for a list that rates players in one league at a time.
export function LeagueSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (leagueId: string) => void
}) {
  const id = useId()
  return (
    <div className="fm-field league-select">
      <label className="fm-label" htmlFor={id}>
        League
      </label>
      <select
        id={id}
        className="fm-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {leagues.map((league) => (
          <option key={league.id} value={league.id}>
            {league.name}
          </option>
        ))}
      </select>
    </div>
  )
}

export function Crumbs({ variant, current }: { variant: VariantSlug; current?: string }) {
  return (
    <nav className="fm-crumbs" aria-label="Breadcrumb">
      <Link to="/players/$variant" params={{ variant }} activeOptions={{ exact: true }}>
        Players
      </Link>
      {current && (
        <>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{current}</span>
        </>
      )}
    </nav>
  )
}

export function NoPlayers() {
  return (
    <EmptyState title="No players yet">
      Players show here after their first visit to FortyMM. Share the app with your club
      to fill the list.
    </EmptyState>
  )
}

export function NoLeagues({ player }: { player: Player }) {
  return (
    <EmptyState title="Not in a league yet">
      {player.displayName} gets a rating in a league after their first match in it.
    </EmptyState>
  )
}

export function NoLeaguePlayers({ league }: { league: League }) {
  return (
    <EmptyState title={`No one plays in the ${league.name} yet`}>
      Players show here after their first match in this league. Pick another league to
      see its players.
    </EmptyState>
  )
}

export function NoMatches({ player }: { player: Player }) {
  return (
    <EmptyState title="No matches yet">
      {player.displayName} hasn’t played a match on FortyMM. Matches show here after
      they’re scored.
    </EmptyState>
  )
}

// The title over a mockup's list of players.
export function ListHead({ lead }: { lead: string }) {
  return (
    <header className="players-head">
      <h1>Players</h1>
      <p>{lead}</p>
    </header>
  )
}
