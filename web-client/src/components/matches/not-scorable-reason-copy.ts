import type { MatchDetails } from '@/api/matches'

export type MatchNotScorableReason = NonNullable<
  MatchDetails['not_scorable_reason']
>

/**
 * Client-side copy for each of the four reasons `ensure_scorable`
 * (api/app/match_scoring.py) rejects a score write with — word-for-word, so
 * what the user reads before ever submitting matches what the write path
 * would have said in its 409/422 (#1288). Shared by score-entry's inline
 * refusal and the match page's call-status banner so a copy edit in one
 * place can't silently drift the other away from the API's actual text.
 */
export const NOT_SCORABLE_REASON_COPY: Record<MatchNotScorableReason, string> = {
  no_opponent: "This match has no opponent and can't be scored.",
  result_posted: 'This match has a posted result; scores are frozen.',
  not_called: "This match hasn't been called to a table yet.",
  not_scorable: 'This match is no longer scorable.',
}
