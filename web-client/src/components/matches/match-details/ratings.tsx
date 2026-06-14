import { Suspense } from 'react'
import { RatingsFetcher } from './ratings/ratings-fetcher'

export interface RatingsProps {
    matchId: string;
}

export function Ratings({ matchId }: RatingsProps) {
    // The card renders nothing unless a rating actually moved, so a visible
    // skeleton would flash then collapse. A visually-hidden status keeps the
    // load announced (and tests a sync handle) while reserving no space.
    return <Suspense fallback={<span className="sr-only" role="status">Loading rating change</span>}>
        <RatingsFetcher matchId={matchId} />
    </Suspense>
}
