import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

import { labelFor, MATCH_LENGTH_OPTIONS } from '../../data/options'
import type { MatchLength, TournamentEvent } from '../../data/types'
import { ReadOnlyValue } from '../../read-only-value'
import { SectionHeader } from '../section-header'

export interface MatchSectionProps {
  event: TournamentEvent
  /** When false (a non-creator), the section renders values instead of
   * controls — a viewer gets a rendering of the data, never a disabled form
   * (ADR 0015). */
  canEdit: boolean
  onChange: (next: TournamentEvent) => void
}

/** The event editor's "Match settings" tab — a rated toggle and a best-of
 * length picker, with a per-length "first to N" breakdown. For a non-creator
 * the toggle and the picker are replaced by their values: a boolean reads as
 * prose ("Not rated"), never as a dead switch (ADR 0015).
 *
 * The rated card's description drops its organizer-facing imperative ("Turn off
 * for casual events") for a viewer, who has no toggle to turn off, and keeps
 * only the descriptive half — copy addresses the reader, not the organizer
 * (ADR 0015, rule 5). */
export const MatchSection = ({
  event,
  canEdit,
  onChange,
}: MatchSectionProps) => {
  const m = event.match
  const setMatch = (patch: Partial<TournamentEvent['match']>) =>
    onChange({ ...event, match: { ...m, ...patch } })

  // The option's label ("Bo5"), never the raw count — and `null` for an unknown
  // length, so `ReadOnlyValue` reads it as unset rather than blank.
  const lengthLabel = labelFor(MATCH_LENGTH_OPTIONS, m.lengthGames, null)

  return (
    <div className="flex flex-col gap-5" data-testid="match-section">
      <SectionHeader
        title="Match settings"
        subtitle="How each individual match is played in this event."
      />

      <Card className="px-4" data-testid="match-rated-card">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-semibold text-[color:var(--fg-1)]">
              Rated
            </div>
            <div
              className="mt-0.5 text-[13px] text-[color:var(--fg-3)]"
              data-testid="match-rated-description"
            >
              {canEdit
                ? 'Results count toward player ratings. Turn off for casual events.'
                : 'Results count toward player ratings.'}
            </div>
          </div>
          {canEdit ? (
            <Switch
              aria-label="Rated"
              checked={m.rated}
              onCheckedChange={(rated) => setMatch({ rated })}
            />
          ) : (
            <ReadOnlyValue className="shrink-0">
              {m.rated ? 'Rated' : 'Not rated'}
            </ReadOnlyValue>
          )}
        </div>
      </Card>

      <Card className="px-4" data-testid="match-length-card">
        <div>
          <div className="text-[15px] font-semibold text-[color:var(--fg-1)]">
            Match length
          </div>
          <div className="mt-0.5 text-[13px] text-[color:var(--fg-3)]">
            Best of{' '}
            <span className="font-mono text-[color:var(--fg-1)]">
              {m.lengthGames}
            </span>{' '}
            games. First to ceil(N/2) wins the match.
          </div>
        </div>

        {canEdit ? (
          <ToggleGroup
            type="single"
            value={String(m.lengthGames)}
            onValueChange={(v) => {
              if (v) setMatch({ lengthGames: Number(v) as MatchLength })
            }}
            className="w-fit"
          >
            {MATCH_LENGTH_OPTIONS.map((o) => (
              <ToggleGroupItem key={o.value} value={String(o.value)}>
                {o.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <ReadOnlyValue className="font-mono">{lengthLabel}</ReadOnlyValue>
        )}

        <div className="grid grid-cols-4 gap-2">
          {MATCH_LENGTH_OPTIONS.map((o) => {
            const wins = Math.ceil(o.value / 2)
            const active = m.lengthGames === o.value
            return (
              <div
                key={o.value}
                className={cn(
                  'rounded-[6px] border px-2.5 py-2 text-[11px]',
                  active
                    ? 'border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)]'
                    : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)]',
                )}
              >
                <div
                  className={cn(
                    'font-mono font-semibold tracking-[0.08em] uppercase',
                    active
                      ? 'text-[color:var(--ball-500)]'
                      : 'text-[color:var(--fg-3)]',
                  )}
                >
                  {o.label}
                </div>
                <div className="mt-0.5 text-[color:var(--fg-2)]">
                  First to {wins}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
