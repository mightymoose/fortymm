import { useId } from 'react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import type { SettingOwnership } from '../../../data/draw-structure'

/** The word on the badge, and the only place ownership is put into words.
 *
 * **Ownership is text, not a colour.** A director must be able to read who owns a number
 * without comparing two shades of grey (ADR 20260808 — "the editor states the owner in
 * words, not only in colour"), and a screen reader has no shades at all. */
const OWNERSHIP_LABEL: Record<SettingOwnership, string> = {
  automatic: 'Automatic',
  manual: 'Yours',
}

export interface SettingRowProps {
  /** The setting's name — `Group count`, `Group size`, `Membership`,
   * `Qualifiers per group`. It is also the row's accessible name, so a test (and a
   * screen reader) addresses the row by the thing it sets. */
  name: string
  /** One short line under the name, saying what the setting means. */
  hint: string
  /**
   * The value the director reads. Already formatted by the caller, because only the
   * caller knows what the number means: `4`, or `6–10` when the groups are uneven, or a
   * whole phrase for Membership.
   */
  value: string
  /**
   * How the value reads, which is also how it is set:
   *
   * - `number` — a figure, in the mono face at display size, beside its `unit`.
   * - `phrase` — prose (`Snake automatically`), in the UI face, with no unit. Membership
   *   is the only setting with no number, so it is the only row that takes this.
   */
  kind: 'number' | 'phrase'
  /** Plain words after the value (`groups`, `players per group`). A `phrase` row has
   * none: its value is already a sentence. */
  unit?: string
  /** Who owns the value — the badge is this and nothing else (ADR 20260808). */
  ownership: SettingOwnership
  /** One line saying where the value came from, e.g. `32 players ÷ 4 groups`. Derived
   * by `deriveDrawStructure` for the three numeric settings, so the copy cannot fork
   * away from the arithmetic it describes. */
  source: string
}

/**
 * One row of the Draw structure tab's setting list: what the setting is called, what it
 * means, what it currently says, **who owns it**, and where that value came from.
 *
 * The four settings share one pattern because they are one kind of thing — a structural
 * setting, owned by the director or derived by the system (ADR 20260808). Written out
 * four times, the badge and the source line would be four places to get the same
 * ownership story right.
 *
 * **The rows share one list with dividers, not one card each.** The divider is the
 * parent's (`divide-y`), so a row contributes no border of its own and the list reads as
 * one draw rather than as four unrelated panels.
 *
 * This chore renders the value as text only. The `Set myself` / `Use automatic` action
 * and the numeric input are chore 3c — and they are *absent*, not disabled: a dead box
 * is the unexplained dead end ADR-0015 forbids.
 */
export const SettingRow = ({
  name,
  hint,
  value,
  kind,
  unit,
  ownership,
  source,
}: SettingRowProps) => {
  const nameId = useId()
  return (
    // A named `region`, so the row is addressable by the setting it holds rather than by
    // its position in the list — the four rows are otherwise identical markup.
    <section
      aria-labelledby={nameId}
      data-testid="draw-setting-row"
      className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <h4
          id={nameId}
          data-testid="draw-setting-name"
          className="text-[15px] font-semibold text-[color:var(--fg-1)]"
        >
          {name}
        </h4>
        <p
          data-testid="draw-setting-hint"
          className="mt-1 text-[12px] leading-snug text-[color:var(--fg-3)]"
        >
          {hint}
        </p>
      </div>

      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span
            data-testid="draw-setting-value"
            className={cn(
              'text-[color:var(--fg-1)]',
              kind === 'number'
                ? 'font-mono text-[22px] leading-none font-semibold'
                : 'text-[15px] font-semibold',
            )}
          >
            {value}
          </span>
          {unit && (
            <span
              data-testid="draw-setting-unit"
              className="text-[13px] text-[color:var(--fg-2)]"
            >
              {unit}
            </span>
          )}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge
            data-testid="draw-setting-ownership"
            variant="outline"
            className="text-[10px] font-semibold tracking-[0.1em] uppercase"
          >
            {OWNERSHIP_LABEL[ownership]}
          </Badge>
          <span
            data-testid="draw-setting-source"
            className="text-[12px] text-[color:var(--fg-3)]"
          >
            {source}
          </span>
        </p>
      </div>
    </section>
  )
}
