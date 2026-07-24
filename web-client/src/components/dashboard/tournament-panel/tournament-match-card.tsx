import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Overline } from '@/components/overline'
import { cn } from '@/lib/utils'
import type { TournamentMatchCardView } from '../tournament-panel-view'
import { TournamentGameChips } from './tournament-match-card/tournament-game-chips'

export interface TournamentMatchCardProps {
  match: TournamentMatchCardView
}

/**
 * The tournament panel's headline card: the one match the player is playing,
 * about to play, or just played.
 *
 * The score is **games won**, not points — the number that decides a match —
 * with the per-game points beneath it as chips. A live card glows, and every
 * state announces itself in words ("Live · Table 4 · Game 4", "Match complete
 * …") as well as in colour.
 */
export const TournamentMatchCard = ({ match }: TournamentMatchCardProps) => {
  const live = match.state === 'live'
  return (
    <div
      className={cn(
        'rounded-[var(--radius-md)] border bg-[color:var(--bg-card)] p-5',
        live
          ? 'border-[color:var(--serve-500)]/35 shadow-[0_0_0_1px_rgba(0,226,154,0.12),0_0_16px_rgba(0,226,154,0.12)]'
          : 'border-[color:var(--border-subtle)]',
      )}
      data-testid="tournament-panel-match-card"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-2 font-mono text-[12px] font-semibold tracking-wider',
            live
              ? 'text-[color:var(--serve-500)]'
              : 'text-[color:var(--fg-3)]',
          )}
        >
          {live ? (
            <span
              className="size-2.5 animate-pulse rounded-full bg-[color:var(--serve-500)] shadow-[0_0_8px_rgba(0,226,154,0.6)]"
              aria-hidden="true"
            />
          ) : match.state === 'completed' ? (
            <Check size={14} strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <Clock size={14} strokeWidth={2} aria-hidden="true" />
          )}
          {match.statusText}
        </span>
        <span className="rounded-full border border-[color:var(--border-subtle)] px-2.5 py-0.5 font-mono text-[12px] font-semibold tracking-wide text-[color:var(--fg-3)]">
          {match.bestOfText}
        </span>
      </div>

      <Overline className="mb-1.5 text-[10px]">Games won · match score</Overline>
      <ScoreRow
        name={match.youName}
        games={match.yourGames}
        won={match.youWon}
        dimmed={match.state === 'completed' && !match.youWon}
      />
      <div className="my-1.5 h-px bg-[color:var(--border-subtle)]" />
      <ScoreRow
        name={match.opponentName}
        games={match.opponentGames}
        won={match.opponentWon}
        dimmed={match.state === 'completed' && !match.opponentWon}
      />

      {match.gamesLegend !== null && (
        <TournamentGameChips legend={match.gamesLegend} games={match.games} />
      )}

      {match.scheduleText !== null && (
        <p className="mt-4 font-mono text-[13px] font-semibold text-[color:var(--ball-500)]">
          {match.scheduleText}
        </p>
      )}

      {(match.action !== null || match.detailsRoute !== null) && (
        <div className="mt-4 flex flex-wrap gap-2.5">
          {match.action !== null && (
            <Button asChild>
              <Link {...match.action.route}>
                {match.action.label}
                <ArrowRight size={16} strokeWidth={2.25} />
              </Link>
            </Button>
          )}
          {match.detailsRoute !== null && (
            <Button asChild variant="outline">
              <Link {...match.detailsRoute}>Match details</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function ScoreRow({
  name,
  games,
  won,
  dimmed,
}: {
  name: string
  games: number
  won: boolean
  dimmed: boolean
}) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="min-w-0 flex-1 truncate text-[19px] font-semibold text-[color:var(--chalk-50)]">
        {name}
      </span>
      {won && (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[color:var(--bg-live-soft)] px-2.5 py-0.5 text-[11px] font-bold text-[color:var(--serve-500)]">
          <Check size={12} strokeWidth={3} aria-hidden="true" />
          Winner
        </span>
      )}
      <span
        className={cn(
          'shrink-0 font-mono text-[40px] leading-none font-bold tabular-nums sm:text-[48px]',
          won
            ? 'text-[color:var(--serve-500)]'
            : dimmed
              ? 'text-[color:var(--fg-3)]'
              : 'text-[color:var(--chalk-50)]',
        )}
      >
        {games}
      </span>
    </div>
  )
}
