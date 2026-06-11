import { Suspense } from 'react'
import { HeadToHeadFetcher } from './head-to-head/head-to-head-fetcher'

export interface HeadToHeadProps {
    matchId: string;
}

export function HeadToHead({ matchId }: HeadToHeadProps) {
    return <Suspense fallback={<div>Loading...</div>}>
        <HeadToHeadFetcher matchId={matchId} />
    </Suspense>
}
