import type { ReactNode } from 'react'

import { Card } from '@/components/ui/card'

export interface HeroStatProps {
  label: string
  /** The primary figure; a string so callers can pass an em-dash placeholder. */
  value: ReactNode
  icon: ReactNode
  /** Optional trailing unit, e.g. "days". */
  suffix?: string
}

/** Slug a label into the lowercase, dash-joined suffix the three testids below
 * share ("Group Play" → "group-play") — one function, so the tile's own testid
 * and its value/label testids can never drift out of step with each other. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** One cell of the tournament-detail stat strip: an accent icon chip beside a
 * mono figure and an uppercase label.
 *
 * Three testids, not one (#1536): `[data-slot=card]` alone is ambiguous (an
 * event card carries the same slot), and a mobile-layout claim is about the
 * TEXT boxes specifically — not the tile's outer box, which also holds the
 * 36px icon chip and would pass a width assertion the text itself fails.
 * Mirrors the `tournament-venue-line`/`tournament-venue-text` split. */
export const HeroStat = ({ label, value, icon, suffix }: HeroStatProps) => {
  const slug = slugify(label)
  return (
    <Card className="flex-row items-center gap-3 px-4" data-testid={`hero-stat-${slug}`}>
      <div className="grid size-9 shrink-0 place-items-center rounded-md bg-[color:var(--bg-accent-soft)] text-[color:var(--ball-500)]">
        {icon}
      </div>
      <div className="min-w-0">
        <div
          data-testid={`hero-stat-value-${slug}`}
          className="font-mono text-[20px] leading-none font-bold tabular-nums text-[color:var(--fg-1)]"
        >
          {value}
          {suffix && (
            <span className="ml-1 text-[13px] font-medium text-[color:var(--fg-3)]">
              {suffix}
            </span>
          )}
        </div>
        <div
          data-testid={`hero-stat-label-${slug}`}
          className="mt-1 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase"
        >
          {label}
        </div>
      </div>
    </Card>
  )
}
