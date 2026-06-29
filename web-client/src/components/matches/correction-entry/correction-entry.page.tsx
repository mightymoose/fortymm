import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import {
  mockMatchDetailsEndpoint,
  type MatchDetailsResolver,
} from "@/mocks/endpoints/matches/match-details.endpoint";
import {
  mockMatchResultsEndpoint,
  type MatchResultsResolver,
} from "@/mocks/endpoints/matches/match-results.endpoint";
import { server } from "@/mocks/server";
import { render, screen, within, type Container } from "@/test/utilities";

import { CorrectionEntry } from "./correction-entry";

const DEFAULT_MATCH_ID = "m-correct-1";

const scoped = (container: Container) => ({
  /** The busy placeholder shown while the match query is pending. */
  queryLoading() {
    return container.queryByTestId("correction-entry-loading");
  },
  /** A side's numeric input within game `gameNumber`, by the participant's name
   * (the field label is `"<name> score"`). Games stack in document order, so we
   * scope to the matching `Game N` section. */
  getInput(gameNumber: number, name: string) {
    const heading = container.getByRole("heading", {
      name: `Game ${gameNumber}`,
    });
    const section = heading.closest("section") as HTMLElement;
    return within(section).getByLabelText(`${name} score`) as HTMLInputElement;
  },
  /** The single shared "Send corrected score" submit (or its pending label). */
  getSubmit() {
    return container.getByRole("button", {
      name: /send corrected score|sending/i,
    });
  },
  /** Any visible `role="alert"` line (per-game score error or the API error). */
  queryAlerts() {
    return container.queryAllByRole("alert");
  },
  /** The match-details landing the route navigates to on a successful send. */
  queryMatchLanding() {
    return container.queryByTestId("match-landing");
  },
});

/**
 * Test page-object for `CorrectionEntry`. The component reads the match via
 * `useMatch` (regular query, `throwOnError`) and writes via `useProposeResult`,
 * and it calls `useNavigate` on success — so it mounts under a memory router
 * with a `/matches/$matchId` landing route, the same shape the real file route
 * uses. Stubs `GET /v1/matches/:matchId` (the pre-fill source) and
 * `POST /v1/matches/:matchId/results` (the propose target).
 */
export const correctionEntryPage = {
  /** Stub the match-details GET that seeds the inputs. */
  mockMatch(resolver: MatchDetailsResolver) {
    mockMatchDetailsEndpoint(server, resolver);
  },

  /** Stub the propose POST the submit fires. */
  mockPropose(resolver: MatchResultsResolver) {
    mockMatchResultsEndpoint(server, resolver);
  },

  render(matchId: string = DEFAULT_MATCH_ID) {
    const rootRoute = createRootRoute();
    const correctRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/correct",
      component: () => <CorrectionEntry matchId={matchId} />,
    });
    const matchRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId",
      component: () => <div data-testid="match-landing">match-landing</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([correctRoute, matchRoute]),
      history: createMemoryHistory({
        initialEntries: [`/matches/${matchId}/correct`],
      }),
    });
    render(<RouterProvider router={router} />);
  },

  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
