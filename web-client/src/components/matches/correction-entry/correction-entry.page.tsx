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
import userEvent from "@testing-library/user-event";
import { render, screen, type Container } from "@/test/utilities";

import { CorrectionEntry } from "./correction-entry";

const DEFAULT_MATCH_ID = "m-correct-1";

const scoped = (container: Container) => ({
  /** The busy placeholder shown while the match query is pending. */
  queryLoading() {
    return container.queryByTestId("correction-entry-loading");
  },
  /** A side's numeric input in the single open pad, by the participant's name
   * (the field label is `"<name> score"`). The board shows one game at a time,
   * switched via the scoreline, so there's never more than one such field. */
  getInput(name: string) {
    return container.getByLabelText(`${name} score`) as HTMLInputElement;
  },
  /** The single "Send corrected score" / "Send updated score" submit (the
   * latter on a proposer self-edit), or its pending label. */
  getSubmit() {
    return container.getByRole("button", {
      name: /send (corrected|updated) score|sending/i,
    });
  },
  /** The in-pad "Clear" action that empties the open game. */
  getClear() {
    return container.getByRole("button", { name: "Clear" });
  },
  /** A scoreline cell — clicking it opens that game in the pad. */
  getCell(gameNumber: number) {
    return container.getByRole("button", {
      name: new RegExp(`^go to game ${gameNumber}\\b`, "i"),
    });
  },
  /** The active (open) scoreline cell. */
  getActiveCell() {
    return container.getByRole("button", { current: "step" });
  },
  /** A scoreline cell's hover-✕ clear (absent on empty slots). */
  getCellClear(gameNumber: number) {
    return container.getByRole("button", { name: `Clear game ${gameNumber}` });
  },
  /** A scoreline cell's hover-✕ clear, or null when the slot is empty. */
  queryCellClear(gameNumber: number) {
    return container.queryByRole("button", {
      name: `Clear game ${gameNumber}`,
    });
  },
  /** Open a game in the pad via its scoreline cell. */
  async selectGame(gameNumber: number) {
    await userEvent.click(this.getCell(gameNumber));
  },
  /** Any visible `role="alert"` line (per-game score error, board hint, or the
   * API error). */
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
      path: "/matches/$matchId/results/new",
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
        initialEntries: [`/matches/${matchId}/results/new`],
      }),
    });
    render(<RouterProvider router={router} />);
  },

  within(container: Container = screen) {
    return scoped(container);
  },

  ...scoped(screen),
};
