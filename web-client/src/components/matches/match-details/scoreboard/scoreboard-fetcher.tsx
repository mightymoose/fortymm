import { useSuspenseQuery } from '@tanstack/react-query'
import { scoreboardQuery } from './scoreboard-query'
import { ScoreboardDisplay } from './scoreboard-display';

export interface ScoreboardProps {
    matchId: string;
}

export function ScoreboardFetcher({ matchId }: ScoreboardProps) {
    const { data: scoreboard } = useSuspenseQuery(scoreboardQuery(matchId))

    return <ScoreboardDisplay scoreboard={scoreboard} />
}
