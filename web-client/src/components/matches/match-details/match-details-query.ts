import { api, unwrap } from "@/api/client";
import type { MatchDetails } from "@/api/matches";
import type { QueryFunctionContext } from "@tanstack/react-query";
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
export type MatchDetailsResult = ReturnType<typeof matchDetailsResultFromPayload>;

export const matchDetailsQuery = (matchId: string) => ({
  queryKey: queryKey(matchId),
  queryFn: fetchMatchDetails,
  throwOnError: true,
});
