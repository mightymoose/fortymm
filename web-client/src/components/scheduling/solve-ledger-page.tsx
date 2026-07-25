import { useCallback, useEffect, useState } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, ListFilter, X } from 'lucide-react'

import { PaginationFooter } from '@/components/pagination-footer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  TRIGGER_LABEL,
  fmtWallTime,
  infeasibilityReasonCopy,
  infeasibilityReasonKey,
  placementConflictKey,
  placementConflictSentence,
} from '@/components/tournaments/data/solve'
import { fmtDateTimeShort } from '@/lib/dates'

import {
  FAILURE_HEADLINE,
  fmtFixtureCounts,
  hasFailureDetail,
  solveChip,
  type SolveChipTone,
} from './ledger'
import {
  SOLVE_LEDGER_PAGE_SIZE,
  adminScheduleSolvesQueryOptions,
  type AdminScheduleSolve,
} from './queries'

// The matches/players list scaffold (action bar, filter row, table chrome,
// footer) — reused so the admin ledger reads as one of the app's list pages,
// exactly as `/players` reuses it. The one addition (a red status tone the
// match list never needed) lives in solve-ledger.css.
import '@/components/matches/match-list/match-list.css'
import './solve-ledger.css'

const COLUMN_COUNT = 8

/** The strip's tints, as the match-list pill tone classes this table borrows.
 * Keyed over the sum type so a new tone is a compile error until it has a
 * class. */
const TONE_CLASS: Record<SolveChipTone, string> = {
  muted: 'status-tone-waiting',
  accent: 'status-tone-called',
  ok: 'status-tone-live',
  warn: 'status-tone-scheduled',
  loss: 'status-tone-loss',
}

export interface SolveLedgerPageProps {
  /** 1-based page from `?page=` (absent = 1), parsed by the route. */
  page: number
  /** `?tournament=` — narrows the ledger to one tournament's runs. */
  tournamentId?: string
}

/**
 * The Administration area's **solve ledger** (ADR "the schedule is solved; the
 * call is pinned"): every run of the placement solver, across every tournament,
 * newest request first — read verbatim off `schedule_solves` via the page's one
 * endpoint.
 *
 * Suspense owns loading (the route's `pendingComponent` is the layout-matched
 * skeleton below) and the admin layout's `RbacBoundary` owns errors — including
 * the server-side `scheduling.view` 403, which renders the designed
 * access-denied panel exactly as on the other admin pages. This component
 * therefore contains no loading or error branches (`DEFINITION_OF_COMPLETE`).
 *
 * The URL is the source of truth for the filter + page, so refresh / share /
 * back keep the spot; filtering is a click on a row's funnel (the row already
 * knows its tournament), cleared by the chip above the table.
 */
export function SolveLedgerPage({ page, tournamentId }: SolveLedgerPageProps) {
  const navigate = useNavigate()
  const { data } = useSuspenseQuery(
    adminScheduleSolvesQueryOptions({ page, tournamentId }),
  )

  const totalPages = Math.max(1, Math.ceil(data.total / SOLVE_LEDGER_PAGE_SIZE))

  // Rewrite the URL — `replace: true` so paging/filtering doesn't fill browser
  // history; defaults are stripped so the URL stays clean (the `/players`
  // pattern).
  const setSearch = useCallback(
    (patch: { page?: number; tournament?: string }) => {
      void navigate({
        to: '/admin/schedule-solves',
        replace: true,
        search: (prev: { page?: number; tournament?: string }) => {
          const merged = { ...prev, ...patch }
          return {
            page: merged.page && merged.page > 1 ? merged.page : undefined,
            tournament: merged.tournament || undefined,
          }
        },
      })
    },
    [navigate],
  )

  const setPage = useCallback((n: number) => setSearch({ page: n }), [setSearch])
  const setTournament = useCallback(
    (id: string | undefined) => setSearch({ tournament: id, page: undefined }),
    [setSearch],
  )

  // Snap an out-of-range `?page=` back to the last valid page once the real
  // total is known (#373 family) — with suspense the data is always settled by
  // the time this runs, so no fetching guards are needed.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages, setPage])

  // The redirect runs in an effect, so an out-of-range page paints for one
  // frame first; clamp what the footer renders with (#637).
  const displayPage = Math.min(page, totalPages)

  // The filter chip names the tournament in the operator's terms when a row on
  // this page can say it; a deep link into an empty filter falls back to the id.
  const filterName =
    data.items.find((s) => s.tournamentId === tournamentId)?.tournamentName ??
    tournamentId

  return (
    <div className="match-list-page solve-ledger">
      <div className="action-bar">
        <div className="action-bar-title">Scheduling</div>
        <div className="action-bar-crumb">Solver run ledger</div>
        {data.total > 0 && (
          <span className="seg-count" style={{ marginLeft: 8 }}>
            {data.total}
          </span>
        )}
        <div className="filter-spacer" />
      </div>
      {tournamentId && (
        <div className="filter-row">
          <Badge variant="outline" data-testid="tournament-filter-chip">
            Tournament: {filterName}
            <button
              type="button"
              className="solve-ledger-chip-clear"
              aria-label="Clear tournament filter"
              onClick={() => setTournament(undefined)}
            >
              <X size={12} strokeWidth={2.4} />
            </button>
          </Badge>
        </div>
      )}
      <div className="table-wrap">
        <LedgerTable
          rows={data.items}
          filtered={Boolean(tournamentId)}
          onFilter={setTournament}
          onClearFilter={() => setTournament(undefined)}
        />
      </div>
      <PaginationFooter
        page={displayPage}
        setPage={setPage}
        total={data.total}
        pageSize={SOLVE_LEDGER_PAGE_SIZE}
        totalPages={totalPages}
        // The shared footer inflects the noun to the count itself — a lone
        // result reads "of 1 run", the rest "of N runs" (#1028).
        noun={{ one: 'run', other: 'runs' }}
      />
    </div>
  )
}

function LedgerHead() {
  return (
    <thead>
      <tr>
        <th style={{ width: 130 }}>Requested</th>
        <th>Tournament</th>
        <th>Trigger</th>
        <th style={{ width: 170 }}>Outcome</th>
        <th style={{ width: 90 }}>Wall time</th>
        <th style={{ width: 150 }}>Fixtures</th>
        <th style={{ width: 110 }}>Re-run</th>
        {/* The details-toggle column — no caption to give it. */}
        <th style={{ width: 48 }} aria-label="Details" />
      </tr>
    </thead>
  )
}

function LedgerTable({
  rows,
  filtered,
  onFilter,
  onClearFilter,
}: {
  rows: AdminScheduleSolve[]
  filtered: boolean
  onFilter: (tournamentId: string) => void
  onClearFilter: () => void
}) {
  // One expansion at a time: the expansion is a reading aid, not a selection.
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (rows.length === 0) {
    // Empty is a designed data state, never a thrown one — and the two empties
    // are different facts: an unfiltered ledger with no rows means no solver
    // has ever run, while a filtered one means *this tournament* has no runs.
    return filtered ? (
      <div className="empty">
        <div className="empty-title">No runs for this tournament</div>
        <div className="empty-sub">
          The scheduler has not been run on the filtered tournament.
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="empty-clear"
          onClick={onClearFilter}
        >
          Clear filter
        </Button>
      </div>
    ) : (
      <div className="empty">
        <div className="empty-title">No solver runs yet</div>
        <div className="empty-sub">
          Every run of the schedule solver lands here — the first will arrive
          when a tournament's scheduler is run.
        </div>
      </div>
    )
  }

  return (
    <table className="matches">
      <LedgerHead />
      <tbody>
        {rows.map((solve) => (
          <LedgerRow
            key={solve.id}
            solve={solve}
            expanded={expandedId === solve.id}
            onToggle={() =>
              setExpandedId((cur) => (cur === solve.id ? null : solve.id))
            }
            onFilter={onFilter}
          />
        ))}
      </tbody>
    </table>
  )
}

function LedgerRow({
  solve,
  expanded,
  onToggle,
  onFilter,
}: {
  solve: AdminScheduleSolve
  expanded: boolean
  onToggle: () => void
  onFilter: (tournamentId: string) => void
}) {
  const chip = solveChip(solve.status, solve.verdict)
  const wall = fmtWallTime(solve.wallTimeMs)
  const counts = fmtFixtureCounts(solve.fixturesPlaced, solve.fixturesPinned)
  // A local, so `hasFailureDetail`'s type predicate narrows it for the
  // `FAILURE_HEADLINE` lookup below (a property access won't stay narrowed).
  const status = solve.status
  const hasFailure = hasFailureDetail(status)
  // A placed board can still carry a caution (ADR "overlapping-in-progress-
  // matches-are-tolerated-and-reported") — orthogonal to the verdict, so a
  // succeeded row with overlapping in-progress matches is expandable too.
  const hasConflicts = solve.placementConflicts.length > 0
  const expandable = hasFailure || hasConflicts
  const detailId = `solve-detail-${solve.id}`

  return (
    <>
      <tr data-testid={`solve-row-${solve.id}`}>
        <td className="time-cell" title={solve.requestedAt}>
          {fmtDateTimeShort(solve.requestedAt)}
        </td>
        <td data-cell="tournament">
          <span className="solve-ledger-tournament">
            <Link
              to="/tournaments/$tournamentId"
              params={{ tournamentId: solve.tournamentId }}
              className="solve-ledger-tournament-link"
            >
              {solve.tournamentName}
            </Link>
            <button
              type="button"
              className="solve-ledger-filter"
              aria-label={`Show only ${solve.tournamentName} runs`}
              onClick={() => onFilter(solve.tournamentId)}
            >
              <ListFilter size={13} strokeWidth={2.2} />
            </button>
          </span>
        </td>
        <td data-label="Trigger">{TRIGGER_LABEL[solve.trigger]}</td>
        <td data-label="Outcome">
          <Badge variant="secondary" className={`status-pill ${TONE_CLASS[chip.tone]}`}>
            {chip.label}
          </Badge>
          {chip.verdict && (
            <div className="solve-ledger-verdict">{chip.verdict}</div>
          )}
        </td>
        <td data-label="Wall time" className="mono">
          {wall ?? '—'}
        </td>
        <td data-label="Fixtures">{counts ?? '—'}</td>
        <td data-label="Re-run">
          {solve.rerunRequested ? (
            <Badge variant="outline" data-testid={`solve-rerun-${solve.id}`}>
              Re-run queued
            </Badge>
          ) : (
            '—'
          )}
        </td>
        <td className="action-cell">
          {expandable && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={expanded ? 'Hide run details' : 'Show run details'}
              onClick={onToggle}
            >
              {expanded ? (
                <ChevronUp size={14} strokeWidth={2.4} />
              ) : (
                <ChevronDown size={14} strokeWidth={2.4} />
              )}
            </Button>
          )}
        </td>
      </tr>
      {expandable && expanded && (
        <tr className="solve-ledger-detail-row">
          <td colSpan={COLUMN_COUNT}>
            <div id={detailId} data-testid={detailId} className="solve-ledger-detail">
              {/* `hasFailure` is `hasFailureDetail`'s type predicate, so `status`
                  is narrowed to the two headline keys here. A placed board with
                  only a conflict caution has no failure headline. */}
              {hasFailure && (
                <div className="solve-ledger-detail-title">
                  {FAILURE_HEADLINE[status]}
                </div>
              )}
              {/* The server's own account of why the job broke — the one wire
                  sentence this page carries, because it is the actionable
                  content (the solve strip's precedent). */}
              {solve.error && (
                <div className="solve-ledger-detail-error mono">{solve.error}</div>
              )}
              {/* Why the day doesn't fit — the SAME resolved reasons the Schedule
                  tab's strip shows, rendered through the one shared
                  `infeasibilityReasonCopy` so the two surfaces cannot drift.
                  Only the `infeasible` arm carries reasons (`[]` off that path);
                  an unexpectedly empty list keeps the headline-only expansion. */}
              {status === 'infeasible' && solve.infeasibilityReasons.length > 0 && (
                <ul className="solve-ledger-detail-reasons">
                  {solve.infeasibilityReasons.map((reason, i) => {
                    const copy = infeasibilityReasonCopy(reason)
                    return (
                      <li key={infeasibilityReasonKey(reason, i)}>
                        <span className="solve-ledger-detail-reason-sentence">
                          {copy.sentence}
                        </span>{' '}
                        <span className="solve-ledger-detail-reason-remedy">
                          {copy.remedy}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
              {/* Overlapping in-progress matches the solve TOLERATED and reported
                  — the SAME caution the Schedule tab's strip shows, rendered
                  through the one shared `placementConflictSentence` so the two
                  surfaces cannot drift. Present on ANY verdict (a placed board
                  can still carry it), so it is not gated on `status`. */}
              {hasConflicts && (
                <div className="solve-ledger-detail-conflicts">
                  <div className="solve-ledger-detail-title solve-ledger-detail-conflicts-title">
                    Overlapping matches on the board
                  </div>
                  <ul className="solve-ledger-detail-reasons">
                    {solve.placementConflicts.map((conflict, i) => (
                      <li key={placementConflictKey(conflict, i)}>
                        <span className="solve-ledger-detail-reason-sentence">
                          {placementConflictSentence(conflict)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="solve-ledger-detail-fingerprint">
                <span className="solve-ledger-detail-label">
                  Input fingerprint
                </span>{' '}
                <span className="mono">{solve.inputFingerprint ?? '—'}</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * The route's `pendingComponent` — the same scaffold (action bar, table chrome,
 * eight ghost rows, no footer) so the resolve is a fill-in, not a reflow.
 */
export function SolveLedgerSkeleton() {
  return (
    <div className="match-list-page solve-ledger">
      <div className="action-bar">
        <div className="action-bar-title">Scheduling</div>
        <div className="action-bar-crumb">Solver run ledger</div>
        <div className="filter-spacer" />
      </div>
      <div className="table-wrap">
        <table className="matches" aria-busy="true">
          <LedgerHead />
          <tbody>
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="skeleton-row" aria-hidden="true">
                <td colSpan={COLUMN_COUNT}>
                  <div className="skeleton-line" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
