import { api, unwrap } from "@/api/client";
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

type MatchDetailsQueryKey = ReturnType<typeof queryKey>;

const fetchMatchDetails = async ({
  queryKey,
}: QueryFunctionContext<MatchDetailsQueryKey>) => {
  const [{ matchId }] = queryKey;
  const result = await api.GET("/v1/matches/{match_id}", {
    params: { path: { match_id: matchId } },
  });

  const data = unwrap(`load match ${matchId}`, result);

  return {
    ...matchDetailsSchema.parse(data),
    unmigrated: data,
  };
};

/** The resolved shape `matchDetailsQuery`'s `queryFn` returns. */
export type MatchDetailsResult = Awaited<ReturnType<typeof fetchMatchDetails>>;

export const matchDetailsQuery = (matchId: string) => ({
  queryKey: queryKey(matchId),
  queryFn: fetchMatchDetails,
  throwOnError: true,
});
