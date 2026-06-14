import type { useNavigate } from '@tanstack/react-router'
import { z } from 'zod'

import type { MatchListParams, MatchStatus } from '@/api/matches'

// Single source of truth for the filter-tab status values — the URL schema,
// the row classification, and the tab list all derive from this tuple.
export const STATUS_KEYS = ['scheduled', 'live', 'final'] as const
export type StatusKey = (typeof STATUS_KEYS)[number]
export type RowTab = StatusKey

// URL is the source of truth for filters. `.trim()` strips whitespace so a
// junk query like `?q=%20%20%20` collapses to "no filter" instead of polluting
// the URL forever. `.optional().catch(undefined)` keeps `?status=garbage` or
// `?page=NaN` from crashing the page — invalid values silently drop back to
// defaults instead of throwing.
export const matchesSearchSchema = z.object({
  q: z.string().trim().min(1).optional().catch(undefined),
  status: z.enum(STATUS_KEYS).optional().catch(undefined),
  page: z.coerce.number().int().min(2).optional().catch(undefined),
})

export const TAB_TO_API: Record<RowTab, MatchStatus> = {
  scheduled: 'pending',
  live: 'in_progress',
  final: 'completed',
}
// Terminal statuses (disputed, voided) fall back to the `final` tone — they
// share final's "no further action" semantics, not scheduled's pending one.
export const API_TO_TAB: Record<MatchStatus, RowTab> = {
  pending: 'scheduled',
  in_progress: 'live',
  completed: 'final',
  disputed: 'final',
  voided: 'final',
}

export const STATUS_TABS: {
  value: 'all' | StatusKey
  label: string
  live?: boolean
}[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live', live: true },
  { value: 'scheduled', label: 'Up next' },
  { value: 'final', label: 'Final' },
]

export const PAGE_SIZE = 25

export const STATUS_TONE: Record<RowTab, string> = {
  live: 'status-tone-live',
  final: 'status-tone-final',
  scheduled: 'status-tone-scheduled',
}

export type NavigateFn = ReturnType<typeof useNavigate>

/** Map the validated URL search to the list query's params. Shared by the
 * loader's prefetch and the component's live query so both hit the same cache
 * key — a hover preload then renders straight from cache on click. */
export function listParamsFromSearch(
  search: z.infer<typeof matchesSearchSchema>,
): MatchListParams {
  return {
    status: search.status ? TAB_TO_API[search.status] : undefined,
    q: search.q || undefined,
    page: search.page ?? 1,
    page_size: PAGE_SIZE,
  }
}
