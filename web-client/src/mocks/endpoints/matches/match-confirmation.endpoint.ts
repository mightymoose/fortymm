import { type HttpResponseResolver, http } from "msw";
import type { components } from "@/api/schema";
import type { server } from "../../server";
import type { worker } from "../../browser";

type Backend = typeof server | typeof worker;
type MatchDetails = components["schemas"]["app__schemas__match__MatchDetails"];

export type MatchConfirmationResolver = HttpResponseResolver<
  { matchId: string },
  never,
  // The error body lets tests drive the inline failure path (e.g. a 409
  // `detail`) through the same typed resolver.
  MatchDetails | { detail: string }
>;

export const mockMatchConfirmationEndpoint = (
  backend: Backend,
  resolver: MatchConfirmationResolver,
) => backend.use(http.post("*/v1/matches/:matchId/confirmation", resolver));
