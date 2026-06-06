import { useSuspenseQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { scoreboardQuery } from './scoreboard/scoreboard-query'
import type { Scoreboard } from './scoreboard/scoreboard-query'

export function ScoreboardProvider({
    matchId,
    children,
}: {
    matchId: string
    children: (scoreboard: Scoreboard) => ReactNode
}) {
    const { data: scoreboard } = useSuspenseQuery(scoreboardQuery(matchId))

    return children(scoreboard)
}
