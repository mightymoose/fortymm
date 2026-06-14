import { Suspense } from 'react'
import { HeadToHeadFetcher } from './head-to-head/head-to-head-fetcher'

export interface HeadToHeadProps {
    matchId: string;
}

export function HeadToHead({ matchId }: HeadToHeadProps) {
    // Renders nothing when there's no shared record, so a visible skeleton
    // would flash then collapse. A visually-hidden status keeps the load
    // announced (and tests a sync handle) while reserving no space.
    return <Suspense fallback={<span className="sr-only" role="status" aria-busy="true" aria-label="Loading head-to-head record" />}>
        <HeadToHeadFetcher matchId={matchId} />
    </Suspense>
}
