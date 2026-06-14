import { Suspense } from 'react'
import { MatchInfoFetcher } from './match-info/match-info-fetcher'
import { MatchInfoSkeleton } from './match-info/match-info-skeleton'

export interface MatchInfoProps {
    matchId: string;
}

export function MatchInfo({ matchId }: MatchInfoProps) {
    return <Suspense fallback={<MatchInfoSkeleton />}>
        <MatchInfoFetcher matchId={matchId} />
    </Suspense>
}
