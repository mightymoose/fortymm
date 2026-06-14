import { Suspense } from 'react'
import { ScoreboardFetcher } from './scoreboard/scoreboard-fetcher'
import { ScoreboardSkeleton } from './scoreboard/scoreboard-skeleton'

export interface ScoreboardProps {
    matchId: string;
}

export function Scoreboard({ matchId }: ScoreboardProps) {
    return <Suspense fallback={<ScoreboardSkeleton />}>
        <ScoreboardFetcher matchId={matchId} />
    </Suspense>
}
