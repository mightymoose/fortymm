import { Suspense } from 'react'
import { MatchInfoFetcher } from './match-info/match-info-fetcher'

export interface MatchInfoProps {
    matchId: string;
}

export function MatchInfo({ matchId }: MatchInfoProps) {
    return <Suspense fallback={<div>Loading...</div>}>
        <MatchInfoFetcher matchId={matchId} />
    </Suspense>
}
