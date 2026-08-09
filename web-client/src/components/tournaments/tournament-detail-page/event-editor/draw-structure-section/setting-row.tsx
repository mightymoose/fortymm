import { useId } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import type { EditFreeze } from '../../../data/draw'
import { acceptedManualEntry } from '../../../data/draw-ownership'
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

/** The manual box, when the director owns the setting. */
export interface SettingRowEntry {
  /** The number in the box, or `null` for a box the director has cleared. `null` is a
   * real state — the derivation reads a manual setting with no number as automatic — and
   * it is emphatically not a `0`, which the API refuses. */
  value: number | null
  /** The largest number this box may hold: the server's own ceiling for this setting
   * (512 for a pool dimension, 1,000 for a qualifier count). */
  max: number
  /** Store what the director typed. Called only with a value the bounds admit, or `null`
   * for a cleared box — a keystroke that would author neither is ignored, so nothing
   * downstream has to defend against a `0`. */
  onChange: (value: number | null) => void
  /**
   * The director has **finished** typing this number — they left the box, or pressed
   * Enter. Optional, because only one setting needs the distinction.
   *
   * `onChange` fires per keystroke, which is right for a number that merely gets stored
   * and wrong for one that **materialises** something. The pool count is the second kind:
   * it is a number of pool rows (ADR 20260808), so a keystroke would mint or drop real
   * reservations for a value that is only a prefix of the number being typed. Against four
   * pools, `55` would mint one row and then fifty more, and `12` would open the removal
   * confirm on its `1` — focus leaves the box, and the `2` never lands. So the whole
   * number waits for this signal, whichever way it moves.
   */
  onCommit?: () => void
}

/** The row's one quiet text action — `Set myself` / `Use automatic`, or Membership's
 * `Assign myself` / `Use snake`. */
export interface SettingRowAction {
  label: string
  onClick: () => void
}

export interface SettingRowProps {
  /** The setting's name — `Pool count`, `Pool size`, `Membership`,
   * `Qualifiers per pool`. It is also the row's accessible name, so a test (and a
   * screen reader) addresses the row by the thing it sets. */
  name: string
  /** One short line under the name, saying what the setting means. */
  hint: string
  /**
   * The value the director reads. Already formatted by the caller, because only the
   * caller knows what the number means: `4`, or `6–10` when the pools are uneven, or a
   * whole phrase for Membership.
   *
   * Shown as text whenever there is no `entry` — a setting the system owns, or one being
   * read by somebody who cannot edit it.
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
  /** Plain words after the value (`pools`, `players per pool`). A `phrase` row has
   * none: its value is already a sentence. */
  unit?: string
  /** Who owns the value — the badge is this and nothing else (ADR 20260808). */
  ownership: SettingOwnership
  /** One line saying where the value came from, e.g. `32 players ÷ 4 pools`. Derived
   * by `deriveDrawStructure` for the three numeric settings, so the copy cannot fork
   * away from the arithmetic it describes. */
  source: string
  /**
   * The direct-entry box, when the director owns this setting **and** may edit it.
   * Absent means the value is read out as text — there is no disabled box anywhere, which
   * is the unexplained dead end ADR-0015 forbids.
   */
  entry?: SettingRowEntry
  /**
   * The one way to change who owns this setting. Absent for a reader.
   *
   * A quiet text button, never a segmented control: four `Automatic / Manual` switches
   * stacked down a column read as a settings panel rather than as a draw, which ADR
   * 20260808 considered and rejected.
   */
  action?: SettingRowAction
  /** One more line under the source, for a consequence the setting carries — today only
   * Membership's `Repeat protection turns off when you assign pools by hand.` */
  note?: string
  /**
   * The inline red, when the resolver (or the server) rejected the value this row holds.
   *
   * Only the qualifier count can produce one today: it is the one setting on this tab the
   * event *must* carry a value for (the server's `rr-then-ko` arm requires K), so it is
   * the one whose box can be left in a state the save is refused for. The row it moved
   * from carried the same slot; a row that dropped it would send a refused save to a tab
   * with nothing red on it — the dead end `firstInvalidSection` exists to prevent.
   */
  error?: string
  /**
   * Whether this setting may still be changed at all (`EditFreeze`, `data/draw`) — a cut
   * draw freezes the qualifier count, because the bracket was cut for it.
   *
   * Frozen means the box and the action are **present, disabled, and pointing at the
   * reason** (`aria-describedby`), never absent: what changed is the state of the event,
   * not who the director is, so the fix for the dead end is the explanation and not a
   * vanishing control (ADR 20260806, the freeze/confirm table). A disabled control is not
   * focusable and carries no tooltip, so the description is the only channel it has left.
   */
  freeze?: EditFreeze
}

/**
 * One row of the Draw structure tab's setting list: what the setting is called, what it
 * means, what it currently says, **who owns it**, where that value came from, and the one
 * action that hands it over or gives it back.
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
 * ## The box has no spinner
 *
 * `<input type="text" inputMode="numeric">`, deliberately, and there are **no plus or
 * minus buttons anywhere** — the reference is explicit about both. A `type="number"`
 * would bring a spinner, a scroll-wheel that silently changes a saved number, and a
 * control a screen reader calls a `spinbutton`; a director setting six pools types `6`
 * and a director correcting it selects the number and replaces it outright.
 *
 * ## One message slot, and the error outranks the freeze
 *
 * A row has at most one thing to say about why it is not simply working: the resolver's
 * red, or the reason it is frozen. They cannot both be true — a frozen row's value is the
 * one the draw was cut from, which is by construction a value the resolver accepts — so
 * they share a slot, in that order, exactly as the Basics row this one replaced did.
 */
export const SettingRow = ({
  name,
  hint,
  value,
  kind,
  unit,
  ownership,
  source,
  entry,
  action,
  note,
  error,
  freeze,
}: SettingRowProps) => {
  const nameId = useId()
  const messageId = useId()
  const frozen = freeze?.kind === 'frozen'
  const message = error ?? (frozen ? freeze.reason : undefined)
  // The box and the action POINT at the message, they do not merely sit above it — and a
  // disabled control has no other channel left. Undefined rather than an empty string when
  // there is nothing to point at: an `aria-describedby` naming an empty node is a
  // description a screen reader reads as silence.
  const describedBy = message === undefined ? undefined : messageId
  return (
    // A named `region`, so the row is addressable by the setting it holds rather than by
    // its position in the list — the four rows are otherwise identical markup.
    <section
      aria-labelledby={nameId}
      data-testid="draw-setting-row"
      className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)_auto]"
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
          {entry ? (
            // Labelled by the row's own heading — the visible words directly to its left,
            // so the accessible name IS what a sighted director reads. A box whose only
            // label were the unit after it would announce as "pools", which is four
            // indistinguishable boxes to a screen reader.
            <Input
              type="text"
              inputMode="numeric"
              data-testid="draw-setting-input"
              aria-labelledby={nameId}
              aria-invalid={!!error}
              aria-describedby={describedBy}
              disabled={frozen}
              className="w-[84px] shrink-0 py-1.5 text-center font-mono text-[20px] leading-none font-semibold"
              // `''` for a cleared box, never a `0`: the two are different answers, and
              // one of them is a 422.
              value={entry.value === null ? '' : String(entry.value)}
              onChange={(e) => {
                const accepted = acceptedManualEntry(e.target.value, entry.max)
                // `undefined` is "not a value this box may hold" — the keystroke is
                // dropped and the box keeps the number the director last chose. It is
                // NOT clamped to the bound: the system never silently changes a
                // director's number (ADR 20260808).
                if (accepted !== undefined) entry.onChange(accepted)
              }}
              // The two ways a director says they are **done typing** this number (see
              // `onCommit`). Both, not one: leaving the box is how a mouse user finishes,
              // and Enter is how somebody who never leaves the keyboard does. Enter
              // submits nothing — the editor's Save is a button, not a form submit — so
              // there is no default to prevent.
              onBlur={entry.onCommit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') entry.onCommit?.()
              }}
            />
          ) : (
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
          )}
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
        {note && (
          <p
            data-testid="draw-setting-note"
            className="mt-1.5 text-[12px] leading-snug text-[color:var(--warn)]"
          >
            {note}
          </p>
        )}
        {/* The red, or the reason — one slot, and the test id says which, so a test
            cannot pass on a freeze reason rendered where an error belongs. */}
        {message !== undefined && (
          <p
            id={messageId}
            data-testid={error ? 'draw-setting-error' : 'draw-setting-freeze'}
            className={cn(
              'mt-1.5 text-[12px] leading-snug',
              error
                ? 'text-[color:var(--loss)]'
                : 'text-[color:var(--fg-3)]',
            )}
          >
            {message}
          </p>
        )}
      </div>

      {action && (
        <div className="sm:pt-0.5 sm:text-right">
          <Button
            variant="link"
            size="sm"
            data-testid="draw-setting-action"
            className="h-auto p-0 text-[13px]"
            disabled={frozen}
            aria-describedby={describedBy}
            // Three rows offer `Set myself`, so the visible words alone name no setting —
            // and a list of buttons is how a screen-reader user meets them, where the
            // row's own region label is nowhere in earshot. The visible words come FIRST,
            // so what a director says out loud to a voice-control tool still matches.
            aria-label={`${action.label} ${name}`}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        </div>
      )}
    </section>
  )
}
