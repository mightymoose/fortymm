import { useId } from 'react'
import { Overline } from '@/components/overline'
import type { TournamentGameChipView } from '../../tournament-panel-view'

export interface TournamentGameChipsProps {
  /** `mightymoose shown first · vs slim-manatee` — without it, two bare numbers
   * are ambiguous about whose is whose. */
  legend: string
  games: TournamentGameChipView[]
}

/**
 * The per-game points behind a match card's games-won score, as chips.
 *
 * Each chip is two numbers, so each carries its own full sentence for assistive
 * tech ("Game 3: mightymoose 11, slim-manatee 9") rather than relying on the
 * legend above it to have been read first.
 */
export const TournamentGameChips = ({
  legend,
  games,
}: TournamentGameChipsProps) => {
  const headingId = useId()
  if (games.length === 0) return null
  return (
    <section
      aria-labelledby={headingId}
      className="mt-4"
      data-testid="tournament-panel-game-chips"
    >
      <Overline as="h4" id={headingId} className="mb-1 text-[10px]">
        Completed games
      </Overline>
      <p className="mb-2.5 text-[13px] text-[color:var(--fg-3)]">{legend}</p>
      <ul className="flex flex-wrap gap-2">
        {games.map((game) => (
          <li
            key={game.label}
            className="inline-flex items-center rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)] px-2.5 py-1.5"
          >
            <span className="mr-2 text-[12px] font-semibold text-[color:var(--chalk-500)]">
              {game.label}
            </span>
            <span
              className="font-mono text-[14px] font-bold tabular-nums text-[color:var(--chalk-50)]"
              aria-hidden="true"
            >
              {game.score}
            </span>
            <span className="sr-only">{game.description}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
