import { C } from '@/components/dashboard/dashboard-tokens'

export interface SkeletonCardProps {
  label: string
  height: number
}

/** A loading placeholder for a dashboard panel — paints an empty inked card and
 * announces itself as a busy status region for assistive tech. */
export const SkeletonCard = ({ label, height }: SkeletonCardProps) => (
  <div
    role="status"
    aria-busy
    aria-label={label}
    style={{
      background: C.ink800,
      border: `1px solid ${C.ink600}`,
      borderRadius: 10,
      minHeight: height,
      minWidth: 0,
    }}
  />
)
