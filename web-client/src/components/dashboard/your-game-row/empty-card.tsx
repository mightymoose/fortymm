import { C, UI } from '@/components/dashboard/dashboard-tokens'
import { Overline } from '@/components/overline'

import { Card } from './card'

export interface EmptyCardProps {
  overline: string
  body: string
}

/** A placeholder dashboard card — an overline label over a muted body line,
 * shown when a stat has no data yet (e.g. not in a rated league). */
export const EmptyCard = ({ overline, body }: EmptyCardProps) => (
  <Card style={{ minWidth: 0 }}>
    <Overline>{overline}</Overline>
    <div
      style={{
        marginTop: 10,
        font: `400 13px ${UI}`,
        color: C.chalk300,
      }}
    >
      {body}
    </div>
  </Card>
)
