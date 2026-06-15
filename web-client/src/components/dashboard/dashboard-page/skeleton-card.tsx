export interface SkeletonCardProps {
  /** Accessible busy label announced while the card loads, e.g. "Loading rating". */
  label: string
  /** Minimum height in px so the placeholder reserves the card's footprint. */
  height: number
}

/**
 * A card-shaped loading placeholder — a labeled `role="status"` box that holds
 * the layout while the dashboard payload resolves. Shared between the
 * attention-panel slot and the your-game-row cards, so it floats to the
 * dashboard-page subtree root.
 */
export const SkeletonCard = ({ label, height }: SkeletonCardProps) => {
  return (
    <div
      role="status"
      aria-busy
      aria-label={label}
      style={{
        background: 'var(--ink-800)',
        border: '1px solid var(--ink-600)',
        borderRadius: 10,
        minHeight: height,
        minWidth: 0,
      }}
    />
  )
}
