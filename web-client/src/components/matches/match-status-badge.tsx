import type { ReactNode } from 'react'

import { AwaitingConfirmationBadge } from './match-status-badge/awaiting-confirmation-badge'
import { FinalMatchBadge } from './match-status-badge/final-match-badge'
import { LiveMatchBadge } from './match-status-badge/live-match-badge'
import { UpcomingMatchBadge } from './match-status-badge/upcoming-match-badge'

export type StatusView =
  | { kind: 'live'; gameNumber: number }
  | { kind: 'awaiting-confirmation' }
  | { kind: 'final' }
  | { kind: 'upcoming'; label: string }

const BADGES: {
  [K in StatusView['kind']]: (status: Extract<StatusView, { kind: K }>) => ReactNode
} = {
  live: ({ gameNumber }) => <LiveMatchBadge gameNumber={gameNumber} />,
  'awaiting-confirmation': () => <AwaitingConfirmationBadge />,
  final: () => <FinalMatchBadge />,
  upcoming: () => <UpcomingMatchBadge />,
}

export function MatchStatusBadge({ status }: { status: StatusView }) {
  const badge = BADGES[status.kind] as (status: StatusView) => ReactNode
  return badge(status)
}
