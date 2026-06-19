import { C } from '@/components/dashboard/dashboard-tokens'
import { Overline } from '@/components/overline'

import { Mono } from '../mono'

export interface StatProps {
  label: string
  value: number | string
}

/** A labeled stat tile inside the rating card — a small overline caption over a
 * monospace value, painted on the dashboard's dark scoreboard surface. */
export const Stat = ({ label, value }: StatProps) => (
  <div
    style={{
      padding: '10px 12px',
      background: C.ink900,
      borderRadius: 8,
      border: `1px solid ${C.ink700}`,
    }}
  >
    <Overline style={{ fontSize: 9 }}>{label}</Overline>
    <Mono size={16} weight={700} style={{ marginTop: 3, display: 'block' }}>
      {value}
    </Mono>
  </div>
)
