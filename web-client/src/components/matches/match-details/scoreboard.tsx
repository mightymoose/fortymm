import { Suspense } from 'react'
import { ScoreboardFetcher } from './scoreboard/scoreboard-fetcher'

export interface ScoreboardProps {
    matchId: string;
}

export function Scoreboard({ matchId }: ScoreboardProps) {
    return <Suspense fallback={<div>Loading...</div>}>
        <ScoreboardFetcher matchId={matchId} />
    </Suspense>
}
