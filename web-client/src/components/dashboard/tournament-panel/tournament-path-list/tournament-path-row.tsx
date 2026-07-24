import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TournamentPathRowView } from '../../tournament-panel-view'

export interface TournamentPathRowProps {
  row: TournamentPathRowView
}

/**
 * One line of a tournament event's schedule: its ordinal, the opponent, and the
 * result-or-time on the right.
 *
 * Every state carries a glyph or a word as well as its colour — a check for a
 * played match, a filled dot for a live one, a hollow one for a match still to
 * come — so the row is never distinguished by colour alone.
 */
export const TournamentPathRow = ({ row }: TournamentPathRowProps) => (
  <li
    className={cn(
      'flex items-center gap-3 rounded-[var(--radius-sm)] border bg-[color:var(--bg-panel)] px-3 py-2.5',
      row.state === 'live'
        ? 'border-[color:var(--serve-500)]/40'
        : 'border-[color:var(--border-subtle)]',
    )}
    data-testid={`tournament-panel-path-row-${row.label}`}
  >
    <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">
      {row.state === 'completed' ? (
        <Check
          size={14}
          strokeWidth={3}
          className={
            row.youWon
              ? 'text-[color:var(--serve-500)]'
              : 'text-[color:var(--fg-3)]'
          }
        />
      ) : (
        <span
          className={cn(
            'size-2.5 rounded-full',
            row.state === 'live'
              ? 'bg-[color:var(--serve-500)] shadow-[0_0_8px_rgba(0,226,154,0.6)]'
              : 'border-[1.5px] border-[color:var(--ink-500)]',
          )}
        />
      )}
    </span>
    <span className="w-6 shrink-0 font-mono text-[12px] text-[color:var(--chalk-500)]">
      {row.label}
    </span>
    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[color:var(--chalk-50)]">
      {row.opponentName}
    </span>
    <span
      className={cn(
        'shrink-0 font-mono text-[12px]',
        row.state === 'upcoming'
          ? 'text-[color:var(--fg-3)]'
          : 'font-bold text-[color:var(--serve-500)]',
        // A loss keeps the row readable without shouting: the detail text
        // already says "Lost 0–2", so the tone only needs to stop claiming a win.
        row.youWon === false && 'text-[color:var(--loss)]',
      )}
    >
      {row.detail}
    </span>
  </li>
)
