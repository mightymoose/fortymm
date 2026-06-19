import { Card } from '@/components/ui/card'

import { Shimmer } from './shimmer'

// Two placeholder rows — the loaded panel shows up to three, but two is enough
// to read as "a list is loading" without over-reserving height for the common
// one-or-two-item case. A panel that resolves to empty hides entirely, so the
// reserved rows can never be more than a brief over-estimate.
const ROWS = 2

/**
 * Loading placeholder for the {@link AttentionPanel}, rendered by the dashboard
 * while its query resolves. Reuses the real panel's `Card` chrome, heading
 * strip, and row layout so the card occupies the same box the loaded panel will
 * — only the leaf heading/avatar/headline/button become shimmer bars. Mirrors
 * `AttentionPanel`'s markup by hand (the real tree isn't mounted during load),
 * so revisit it if that structure changes.
 */
export const AttentionPanelSkeleton = () => (
  <section
    role="status"
    aria-busy="true"
    aria-label="Loading attention panel"
    className="mb-8"
  >
    <Card className="flex flex-col gap-0 p-0" aria-hidden="true">
      <div className="px-5 pt-4 pb-3">
        <Shimmer width={180} height={20} />
      </div>
      {Array.from({ length: ROWS }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-t border-[color:var(--ink-700)] px-5 py-3"
        >
          <Shimmer width={40} height={40} radius={20} />
          <Shimmer height={16} style={{ flex: 1, maxWidth: 220 }} />
          <Shimmer width={96} height={32} radius={8} />
        </div>
      ))}
      <div className="border-t border-[color:var(--ink-700)] px-5 py-3">
        <Shimmer width={140} height={13} />
      </div>
    </Card>
  </section>
)
