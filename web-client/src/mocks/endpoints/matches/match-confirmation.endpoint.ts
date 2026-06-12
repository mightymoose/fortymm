import { type HttpResponseResolver, http } from "msw";
import type { components } from "@/api/schema";
import type { server } from "../../server";
import type { worker } from "../../browser";
import type { ErrorBody } from "../error-body";

type Backend = typeof server | typeof worker;
type MatchDetails = components["schemas"]["app__schemas__match__MatchDetails"];

export type MatchConfirmationResolver = HttpResponseResolver<
  { matchId: string },
  never,
  MatchDetails | ErrorBody
>;

export const mockMatchConfirmationEndpoint = (
  backend: Backend,
  resolver: MatchConfirmationResolver,
) => backend.use(http.post("*/v1/matches/:matchId/confirmation", resolver));
