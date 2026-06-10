import { Suspense } from 'react'
import { RatingsFetcher } from './ratings/ratings-fetcher'

export interface RatingsProps {
    matchId: string;
}

export function Ratings({ matchId }: RatingsProps) {
    return <Suspense fallback={<div>Loading...</div>}>
        <RatingsFetcher matchId={matchId} />
    </Suspense>
}
