import { useSuspenseQuery } from "@tanstack/react-query";

import { RatingsDisplay } from "./ratings-fetcher/ratings-display";
import { ratingsQuery } from "./ratings-fetcher/ratings-query";

export interface RatingsProps {
  matchId: string;
}

export function RatingsFetcher({ matchId }: RatingsProps) {
  const { data: ratings } = useSuspenseQuery(ratingsQuery(matchId));

  // A null projection means the card has nothing to say — the match isn't
  // final yet, or no rating moved.
  if (!ratings) return null;
  return <RatingsDisplay ratings={ratings} />;
}
