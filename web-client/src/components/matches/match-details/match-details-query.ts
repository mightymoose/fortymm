import { api, unwrap } from "@/api/client";
import type { MatchDetails } from "@/api/matches";
import type { Query, QueryFunctionContext } from "@tanstack/react-query";
import z from "zod";

const scoreboardSchema = z.object({
  status: z.enum(["scheduled", "live", "final"]),
});

const matchDetailsDataSchema = z.object({
  scoreboard: scoreboardSchema,
});

const matchDetailsSchema = z.object({
  data: matchDetailsDataSchema,
});

const queryKey = (matchId: string) =>
  [{ scope: "matches", version: "v1", entity: "details", matchId }] as const;

/** The cache key the scoreboard (`scoreboardQuery` → `matchDetailsQuery`)
 * reads from. Mutations that change a match must invalidate this — it is a
 * different key from `matchQueryKey` in `@/api/matches`, which backs
 * `useMatch`, so updating one does not refresh the other. */
export const matchDetailsQueryKey = queryKey;

type MatchDetailsQueryKey = ReturnType<typeof queryKey>;

const fetchMatchDetails = async ({
  queryKey,
}: QueryFunctionContext<MatchDetailsQueryKey>) => {
  const [{ matchId }] = queryKey;
  const result = await api.GET("/v1/matches/{match_id}", {
    params: { path: { match_id: matchId } },
  });

  const data = unwrap(`load match ${matchId}`, result);

  return matchDetailsResultFromPayload(data);
};

/** Build the cache value `matchDetailsQuery` resolves to from a full
 * `MatchDetails` payload the caller already holds. Used by the queryFn (from the
 * GET response) and to seed the details cache from the `POST /v1/matches`
 * response before navigating to a just-created match (#510). Runs the parse, so
 * a malformed payload fails loudly rather than priming a bad cache entry. */
export function matchDetailsResultFromPayload(payload: MatchDetails) {
  return { ...matchDetailsSchema.parse(payload), unmigrated: payload };
}

/** The resolved shape `matchDetailsQuery`'s `queryFn` returns. */
export type MatchDetailsResult = ReturnType<
  typeof matchDetailsResultFromPayload
>;

/** The server's lifecycle label for a posted-but-unconfirmed result (mirrors
 * `_status_label` in api/app/matches.py). While a match sits here it is waiting
 * on the *other* side to confirm — a transition that happens in a different
 * browser session and so triggers no cache invalidation on this page. */
const AWAITING_CONFIRMATION = "Awaiting confirmation";

/** How often (ms) to re-poll `GET /v1/matches/{id}` while a result is awaiting
 * the opponent's confirmation. */
const AWAITING_CONFIRMATION_POLL_MS = 5_000;

/** Poll only while the match is awaiting the opponent's confirmation, and stop
 * once it leaves that state (confirmed → Final, or contested → Disputed).
 *
 * The reporter posts a result, then leaves the match page open; the opponent
 * confirms in their own session. Nothing invalidates the reporter's cache, and
 * the global client disables `refetchOnWindowFocus` with a 30s `staleTime`, so
 * without this the page is stuck on "Awaiting confirmation" until a manual
 * reload (#493). Returning `false` outside that state means a settled match
 * isn't polled, so the open page goes quiet again once it resolves.
 *
 * Exception: never poll while it's the viewer's *own* turn to act
 * (`negotiation.your_turn` — the `review`/`corrected` states). A silent poll
 * there swaps the standing result out from under the reviewer, so their
 * still-rendered Accept finalizes a correction they never re-reviewed (#726).
 * Freezing the rendered result means accepting a now-superseded one 409s, and
 * the callout surfaces that as a "reload to re-review" prompt. Spectators and
 * the waiting proposer have `your_turn=false`, so they keep polling. */
export function refetchWhileAwaitingConfirmation(
  query: Pick<Query<MatchDetailsResult>, "state">,
): number | false {
  const data = query.state.data?.unmigrated;
  if (data?.status_label !== AWAITING_CONFIRMATION) return false;
  if (data.negotiation.your_turn) return false;
  return AWAITING_CONFIRMATION_POLL_MS;
}

export const matchDetailsQuery = (matchId: string) => ({
  queryKey: queryKey(matchId),
  queryFn: fetchMatchDetails,
  throwOnError: true,
  refetchInterval: refetchWhileAwaitingConfirmation,
});
