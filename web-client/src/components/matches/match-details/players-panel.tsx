import { Suspense } from 'react'
import { PlayersPanelFetcher } from './players-panel/players-panel-fetcher'
import { PlayersPanelSkeleton } from './players-panel/players-panel-skeleton'

export interface PlayersPanelProps {
    matchId: string;
}

export function PlayersPanel({ matchId }: PlayersPanelProps) {
    return <Suspense fallback={<PlayersPanelSkeleton />}>
        <PlayersPanelFetcher matchId={matchId} />
    </Suspense>
}
