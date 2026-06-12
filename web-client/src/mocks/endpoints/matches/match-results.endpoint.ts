import { type HttpResponseResolver, http } from "msw";
import type { components } from "@/api/schema";
import type { server } from "../../server";
import type { worker } from "../../browser";

type Backend = typeof server | typeof worker;
type MatchDetails = components["schemas"]["app__schemas__match__MatchDetails"];
type MatchResultsWrite = components["schemas"]["MatchResultsWrite"];

export type MatchResultsResolver = HttpResponseResolver<
  { matchId: string },
  MatchResultsWrite,
  MatchDetails
>;

export const mockMatchResultsEndpoint = (
  backend: Backend,
  resolver: MatchResultsResolver,
) => backend.use(http.post("*/v1/matches/:matchId/results", resolver));
