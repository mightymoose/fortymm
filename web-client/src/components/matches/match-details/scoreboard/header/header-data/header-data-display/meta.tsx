import { Clock } from 'lucide-react'

import {
  MatchStatusBadge,
  type StatusView,
} from '@/components/matches/match-status-badge'

export interface MetaProps {
  status: StatusView;
  bestOf: number;
}

export function Meta({ status, bestOf }: MetaProps) {
  const isUpcoming = status.kind === 'upcoming';
  const gamesToWin = Math.ceil(bestOf / 2);

  return (
    <div className="md-hero__strip">
      <div className="md-hero__strip-l">
        <MatchStatusBadge status={status} />
      </div>
      <div className="md-hero__strip-r">
        <span className="md-hero__strip-meta">SINGLES · BO{bestOf}</span>
        {!isUpcoming && (
          <span className="md-hero__strip-meta md-hero__strip-meta--with-icon">
            <Clock size={13} strokeWidth={1.75} />
            First to {gamesToWin}
          </span>
        )}
      </div>
    </div>
  )
}
