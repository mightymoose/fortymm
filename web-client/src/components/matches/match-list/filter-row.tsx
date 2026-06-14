import { Search, X } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { StatusKey } from './match-list-status'

export interface FilterTabView {
  /** Tab value passed back to setStatus: 'all' | StatusKey. */
  value: 'all' | StatusKey
  /** Visible label, e.g. 'All', 'Live', 'Up next', 'Final'. */
  label: string
  /** True for the Live tab — renders the leading live-dot. */
  isLive: boolean
  /** The count badge, or null when counts are unknown (no status_counts yet). */
  count: number | null
}

export interface FilterRowProps {
  /** Live (un-debounced) search text mirrored from the URL. */
  q: string
  setQ: (v: string) => void
  /** Currently-selected tab. */
  status: 'all' | StatusKey
  setStatus: (v: 'all' | StatusKey) => void
  /** Pre-built tab descriptors with resolved counts. */
  tabs: FilterTabView[]
}

export const FilterRow = ({ q, setQ, status, setStatus, tabs }: FilterRowProps) => {
  return (
    <div className="filter-row">
      <div className="ml-search">
        <Search className="ml-search-icon" size={16} strokeWidth={2} />
        <Input
          className="h-9 pl-9 pr-9"
          placeholder="Search players…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button
            type="button"
            className="ml-search-clear"
            onClick={() => setQ('')}
            aria-label="Clear search"
          >
            <X size={12} strokeWidth={2.4} />
          </button>
        )}
      </div>

      <Tabs
        value={status}
        onValueChange={(v) => setStatus(v as 'all' | StatusKey)}
      >
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="gap-1.5">
              {t.isLive && <span className="live-dot" />}
              {t.label}
              {t.count !== null && <span className="seg-count">{t.count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )
}
