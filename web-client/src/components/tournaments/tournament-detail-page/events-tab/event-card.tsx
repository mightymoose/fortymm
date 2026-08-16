import { ChevronRight, Eye, Layers, Pencil, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import {
  capacityFillPercent,
  capacityLabel,
  enteredSummary,
  eventCapacity,
} from '../../data/capacity'
import {
  EM_DASH,
  fmtDateShort,
  fmtTimeWindow,
  formatPredicate,
} from '../../data/helpers'
import { FORMAT_OPTIONS, labelFor } from '../../data/options'
import type { DrawTypeOption, TournamentEvent } from '../../data/types'
import { EntrantsList } from './entrants-list'

export interface EventCardProps {
  event: TournamentEvent
  /** When false (a non-owner), the card opens a read-only editor — the
   * affordance reads "View" instead of "Edit". */
  canEdit: boolean
  /** The draw formats the server offers (ADR 20260726) — the catalogue this card
   * resolves `event.drawType` through to get the words beside the format. The card
   * authors no copy for a draw type and holds no list of its own. */
  drawTypes: DrawTypeOption[]
  /** The signed-in player's username, handed to the roster so it can pin their
   * own chip into the visible slice (#781). Absent when signed out, or while
   * the session is still in flight. */
  username?: string | null
  onOpen: () => void
  /**
   * The card's own interactive control (e.g. Enter / Withdraw), rendered in the
   * action column. It is a **sibling** of the stretched open target, never a
   * descendant of it — a `<button>` inside a `<button>` is invalid HTML and a
   * keyboard trap — and it is raised above the overlay so it takes its own
   * clicks instead of opening the editor.
   */
  action?: ReactNode
  /**
   * The event's **draw** (`DrawPanel`) — the pools it was cut across, and the
   * director's cut / re-cut / delete verbs (ADR-0786). A slot, like `action`, and
   * for the same reason: it reads the session and owns two mutations, and this
   * card is a pure view over its props.
   *
   * Rendered in its own raised layer, *above* the stretched open target — it holds
   * real buttons, and a control under that overlay would be dead. That also means a
   * click anywhere in the draw is a click on the draw, not on "open the editor",
   * which is what you want of a panel a director reads a fixture list off.
   */
  draw?: ReactNode
}

/** A row card for one event on the tournament's Events tab: title with rated /
 * best-of badges, eligibility chips, the time slot, pool/table counts, the
 * entries the event holds against its cap (with how many places that leaves), and
 * the roster of entrants those numbers count. The whole card opens the editor.
 *
 * Clicking the card is a stretched button overlaid on the (non-interactive)
 * card body — the same idiom as `TournamentCard` — rather than a `<button>`
 * wrapping the body, so the card can host controls of its own (`action`)
 * without nesting buttons. */
export const EventCard = ({
  event: ev,
  canEdit,
  drawTypes,
  username,
  onOpen,
  action,
  draw,
}: EventCardProps) => {
  // What the EVENT has left — read off the numbers, never off `entryState`.
  // `entryState` is the server's judgement about *this caller* (an ineligible one
  // reads `rating_ineligible` on an event that is also full, ADR-0783), so it can
  // neither count the free places nor be relied on to admit a full event is full.
  // The capacity line is a fact about the event; the entry control beside it is the
  // fact about the caller. See `../../data/capacity`.
  //
  // An **uncapped** event (`maxPlayers === null`, ADR-0935) is its own arm of that
  // reading, not a big number: it has no denominator, so it gets no fill bar — and it
  // can never be full, however many have entered.
  const capacity = eventCapacity(ev)
  const fillPct = capacityFillPercent(ev)
  const isFull = capacity.state === 'full'
  const uncapped = capacity.state === 'uncapped'
  // Falling back to the stored key, not to `null`: a card must never blank out a
  // row, so an unknown key shows *something* (cf. the read-only `Field`s, which
  // pass `null` and let the em-dash say "unset"). The format list is this client's
  // own and its keys are the wire's, so the key and the label are never far apart.
  const formatLabel = labelFor(FORMAT_OPTIONS, ev.format, ev.format)
  // The DRAW TYPE is different, and falls back to an EM-DASH instead. Its labels come
  // from the server's catalogue (ADR 20260726), so "no entry for this key" means the
  // catalogue did not reach this card — and printing `round-robin` at a director would
  // be exactly the leak `labelFor` exists to prevent, in the one place a slug looks
  // plausible enough to survive review. An em-dash says "unknown" without lying, and
  // still keeps the row's shape.
  const drawLabel = labelFor(drawTypes, ev.drawType, EM_DASH)
  const tableCount = new Set(ev.reservations.flatMap((r) => r.tableIds)).size
  // The card opens the editor, which is read-only for a non-owner — so the
  // affordance reads "View" (not "Edit") when the viewer can't mutate.
  const actionLabel = canEdit ? 'Edit' : 'View'
  const ActionIcon = canEdit ? Pencil : Eye

  return (
    <div className="group/ecard relative">
      <Card className="p-0 ring-[color:var(--border-subtle)] transition-colors group-hover/ecard:ring-[color:var(--border-default)]">
        <div className="grid grid-cols-1 gap-4 p-[18px] sm:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-6">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
              <span className="min-w-0 text-[20px] font-bold text-[color:var(--fg-1)]">
                {ev.name}
              </span>
              {ev.match.rated && (
                <Badge
                  variant="outline"
                  className="border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] text-[color:var(--ball-500)]"
                >
                  <TrendingUp size={12} />
                  Rated
                </Badge>
              )}
              <Badge variant="outline" className="font-mono">
                Bo{ev.match.lengthGames}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-[13px] whitespace-nowrap text-[color:var(--fg-3)]">
              <span>{formatLabel}</span>
              <span>·</span>
              <span>{drawLabel}</span>
            </div>
            {ev.predicates.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1">
                {ev.predicates.map((p) => (
                  <Badge key={p.id} variant="ghost" className="border-[color:var(--border-subtle)]">
                    {formatPredicate(p)}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
              Time slot
            </div>
            <div className="mt-1 font-mono text-[13px] tabular-nums text-[color:var(--fg-1)]">
              {fmtDateShort(ev.slot.date)} · {fmtTimeWindow(ev.slot.start, ev.slot.end)}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] whitespace-nowrap text-[color:var(--fg-3)]">
              <Layers size={12} />
              <span>
                {ev.reservations.length}{' '}
                {ev.reservations.length === 1 ? 'reservation' : 'reservations'}
              </span>
              <span>·</span>
              <span className="font-mono">
                {tableCount} {tableCount === 1 ? 'table' : 'tables'}
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
              Entries
            </div>
            {/* The count, as a numeral — and, for a screen reader, as the sentence
                the numeral is shorthand for: "12 / 64" announced literally is
                punctuation, not a fact about entries. One or the other reaches any
                given reader, never both. */}
            <div className="mt-1 flex items-baseline gap-1" aria-hidden="true">
              <span
                className={cn(
                  'font-mono text-[20px] font-bold tabular-nums',
                  isFull ? 'text-[color:var(--warn)]' : 'text-[color:var(--fg-1)]',
                )}
              >
                {ev.entered}
              </span>
              <span className="font-mono text-[13px] text-[color:var(--fg-3)]">
                {uncapped ? 'entered' : `/ ${ev.maxPlayers}`}
              </span>
            </div>
            <span className="sr-only">{enteredSummary(ev)}</span>
            {/* No fill bar for an uncapped event — there is no denominator to fill
                against (ADR-0935), so `capacityFillPercent` returns `null` and there
                is no width to draw. A `0%` rail would look like an empty event and a
                `100%` one like a full one; it is neither. */}
            {fillPct !== null && (
              <div
                data-testid="capacity-bar"
                aria-hidden="true"
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-[color:var(--bg-panel)]"
              >
                <div
                  className={cn(
                    'h-full',
                    isFull ? 'bg-[color:var(--warn)]' : 'bg-[color:var(--ball-500)]',
                  )}
                  style={{ width: `${fillPct}%` }}
                />
              </div>
            )}
            {/* What the numeral leaves the reader to work out: how many places are
                left — or, once there are none, that there are none, or that there was
                never a limit at all. A full event reads FULL; it never counts down to
                "0 places left", and an over-full one (a cap lowered under a field that
                has already formed) never counts *past* it into a negative. An uncapped
                one says so, rather than leaving the one blank line on a wall of cards
                that all state a fact. */}
            <p
              data-testid="capacity-remaining"
              className={cn(
                'mt-1.5 text-[12px] leading-snug',
                isFull
                  ? 'font-medium text-[color:var(--warn)]'
                  : 'text-[color:var(--fg-3)]',
              )}
            >
              {capacityLabel(capacity)}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* The card's own control sits above the stretched open target, so
                it takes its own clicks instead of opening the editor.
                `empty:hidden` because the hosted control decides for itself
                whether it applies (e.g. no Enter for a doubles event) and may
                render nothing — an empty flex item would still take the parent's
                `gap-2` and shift the row. */}
            {action && (
              <div className="relative z-10 flex items-center empty:hidden">
                {action}
              </div>
            )}
            <span className="pointer-events-none inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[color:var(--border-default)] px-3 text-[13px] font-medium text-[color:var(--fg-1)]">
              <ActionIcon size={14} />
              {actionLabel}
            </span>
            <ChevronRight size={16} className="text-[color:var(--fg-3)]" />
          </div>
        </div>

        {/* Who is actually in this event — the roster behind the `entered`
            numeral above. It takes the viewer's username so an entered player
            always sees their own chip, however long the roster is (#781). Inert
            (no controls of its own), so it sits happily under the stretched open
            target. */}
        <EntrantsList event={ev} username={username} />

        {/* The draw (ADR-0786). Raised above the stretched open target below, because
            unlike the roster it holds real controls — the director's Generate / Re-cut /
            Delete — and a button underneath that overlay would never receive a click.
            `empty:hidden` is not needed: the panel always renders *something* (its
            empty state is a designed data state, not nothing). */}
        {draw && <div className="relative z-10">{draw}</div>}
      </Card>

      {/* Full-card open target: a sibling of the card, sitting beneath the
          card's own controls. */}
      <button
        type="button"
        aria-label={`${actionLabel} ${ev.name}`}
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-xl outline-offset-2"
      />
    </div>
  )
}
