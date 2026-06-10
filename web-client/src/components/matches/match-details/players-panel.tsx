import { Suspense } from 'react'
import { PlayersPanelFetcher } from './players-panel/players-panel-fetcher'

export interface PlayersPanelProps {
    matchId: string;
}

export function PlayersPanel({ matchId }: PlayersPanelProps) {
    return <Suspense fallback={<div>Loading...</div>}>
        <PlayersPanelFetcher matchId={matchId} />
    </Suspense>
}
