import { useSuspenseQuery } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { scoreboardQuery, type ScoreboardView } from './scoreboard-query'
import { ScoreboardDisplay } from './scoreboard-display';

export interface ScoreboardProps {
    matchId: string;
    children: (scoreboard: ScoreboardView) => ReactNode;
}

export function ScoreboardFetcher({
    matchId,
    children,
}: ScoreboardProps) {
    const { data: scoreboard } = useSuspenseQuery(scoreboardQuery(matchId))

    return <ScoreboardDisplay scoreboard={scoreboard} children={children} />
}
