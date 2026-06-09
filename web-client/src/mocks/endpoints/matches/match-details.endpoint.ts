import { type HttpResponseResolver, http } from "msw";
import type { components } from "@/api/schema";
import type { server } from "../../server";
import type { worker } from "../../browser";

type Backend = typeof server | typeof worker;
type MatchDetails = components["schemas"]["app__schemas__match__MatchDetails"];

export type MatchDetailsResolver = HttpResponseResolver<
  { matchId: string },
  never,
  MatchDetails
>;

export const mockMatchDetailsEndpoint = (
  backend: Backend,
  resolver: MatchDetailsResolver,
) => backend.use(http.get("*/v1/matches/:matchId", resolver));
