import { Suspense, type ReactNode } from 'react'
import { ScoreboardFetcher } from './scoreboard/scoreboard-fetcher'
import type { ScoreboardView } from './scoreboard/scoreboard-query'

export interface ScoreboardProps {
    matchId: string;
    children: (scoreboard: ScoreboardView) => ReactNode;
}

export function Scoreboard({
    matchId,
    children,
}: ScoreboardProps) {
    return <Suspense fallback={<div>Loading...</div>}>
        <ScoreboardFetcher matchId={matchId} children={children} />
    </Suspense>
}
