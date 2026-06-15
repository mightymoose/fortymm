import { Overline } from '@/components/overline'

import { Mono } from '../mono'

export interface StatProps {
  /** Stat name (overline), e.g. "Peak", "RD". */
  label: string
  /** Pre-formatted value. */
  value: number | string
}

/** A single rating stat tile: a tiny overline label above a bold mono value. */
export const Stat = ({ label, value }: StatProps) => {
  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'var(--ink-900)',
        borderRadius: 8,
        border: '1px solid var(--ink-700)',
      }}
    >
      <Overline style={{ fontSize: 9 }}>{label}</Overline>
      <Mono size={16} weight={700} style={{ marginTop: 3, display: 'block' }}>
        {value}
      </Mono>
    </div>
  )
}
