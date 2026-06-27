import { type HttpResponseResolver, http } from "msw";
import type { components } from "@/api/schema";
import type { server } from "../../server";
import type { worker } from "../../browser";
import type { ErrorBody } from "../error-body";

type Backend = typeof server | typeof worker;
type MatchDetails = components["schemas"]["app__schemas__match__MatchDetails"];

export type MatchWithdrawalResolver = HttpResponseResolver<
  { matchId: string },
  never,
  MatchDetails | ErrorBody
>;

export const mockMatchWithdrawalEndpoint = (
  backend: Backend,
  resolver: MatchWithdrawalResolver,
) => backend.use(http.post("*/v1/matches/:matchId/withdrawal", resolver));
