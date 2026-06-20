import { Card } from '@/components/ui/card'

import { Shimmer } from './shimmer'

/**
 * Loading placeholder for the {@link AttentionPanel}, rendered by the dashboard
 * while its query resolves. Unlike the other dashboard cards, the real attention
 * panel is *conditional* — it hides entirely when nothing is pending, which is
 * the common case — so a full-height skeleton would reserve a phantom panel that
 * vanishes on load and lurches the rest of the page upward. We deliberately
 * reserve only a single compact row (heading + one action row, no footer) to
 * keep that shift small in both directions: a modest over-estimate when the
 * panel turns out empty, a modest under-estimate when it has rows. Reuses the
 * real panel's `Card` chrome and row classes; mirrors `AttentionPanel`'s markup
 * by hand (the real tree isn't mounted during load), so revisit it if that
 * structure changes.
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
      <div className="flex items-center gap-3 border-t border-[color:var(--ink-700)] px-5 py-3">
        <Shimmer width={40} height={40} radius={20} />
        <Shimmer height={16} style={{ flex: 1, maxWidth: 220 }} />
        <Shimmer width={96} height={32} radius={8} />
      </div>
    </Card>
  </section>
)
