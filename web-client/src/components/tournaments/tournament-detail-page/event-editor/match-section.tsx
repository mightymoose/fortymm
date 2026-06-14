import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

import { MATCH_LENGTH_OPTIONS } from '../../data/options'
import type { MatchLength, TournamentEvent } from '../../data/types'
import { SectionHeader } from '../section-header'

export interface MatchSectionProps {
  event: TournamentEvent
  onChange: (next: TournamentEvent) => void
}

/** The event editor's "Match settings" tab — a rated toggle and a best-of
 * length picker, with a per-length "first to N" breakdown. */
export const MatchSection = ({ event, onChange }: MatchSectionProps) => {
  const m = event.match
  const setMatch = (patch: Partial<TournamentEvent['match']>) =>
    onChange({ ...event, match: { ...m, ...patch } })

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Match settings"
        subtitle="How each individual match is played in this event."
      />

      <Card className="px-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[15px] font-semibold text-[color:var(--fg-1)]">
              Rated
            </div>
            <div className="mt-0.5 text-[13px] text-[color:var(--fg-3)]">
              Results count toward player ratings. Turn off for casual events.
            </div>
          </div>
          <Switch
            aria-label="Rated"
            checked={m.rated}
            onCheckedChange={(rated) => setMatch({ rated })}
          />
        </div>
      </Card>

      <Card className="px-4">
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
