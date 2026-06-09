import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { render, screen } from "@testing-library/react";

import { server } from "@/mocks/server";
import {
  MatchDetailsError,
  MatchDetailsView,
} from "@/components/matches/match-details-page";

import { scoreboardPage } from "./match-details/scoreboard.page";

type MatchDetailsResponse = Parameters<typeof HttpResponse.json>[0];

/**
 * Test page-object for the match-details page. This is the landing pad for the
 * scoreboard strangler migration: it starts focused on the `Scoreboard` seam
 * (the hero region) and will grow as more of `match-details-page.tsx` moves
 * here. Builds the same router + query harness the legacy
 * `match-details-page.test.tsx` uses so typed `<Link>`s resolve, and stubs the
 * single `GET /v1/matches/:matchId` BFF endpoint the page (and the hero's
 * `Scoreboard`) read.
 */
export const matchDetailsPage = {
  /** Stub `GET /v1/matches/:matchId` with a `matchDetails(...)` payload. */
  mockMatch(matchId: string, match: MatchDetailsResponse) {
    server.use(
      http.get(`*/v1/matches/${matchId}`, () => HttpResponse.json(match)),
    );
  },

  render(matchId: string, { standalone = false }: { standalone?: boolean } = {}) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute();
    const detailsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/details",
      component: () => (
        <MatchDetailsView matchId={matchId} standalone={standalone} />
      ),
      errorComponent: MatchDetailsError,
    });
    // Route stubs the real route would navigate to — registered so typed
    // <Link>s in the page resolve at render time.
    const scoringNew = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/games/$gameNumber/scores/new",
      component: () => <div>scoring-new</div>,
    });
    const scoringEdit = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/games/$gameNumber/scores/edit",
      component: () => <div>scoring-edit</div>,
    });
    const matchesList = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches",
      component: () => <div>matches-list</div>,
    });
    const matchPage = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId",
      component: () => <div>match-page</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        detailsRoute,
        scoringNew,
        scoringEdit,
        matchesList,
        matchPage,
      ]),
      history: createMemoryHistory({ initialEntries: ["/details"] }),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  },

  /**
   * The hero is rendered through the `Scoreboard` wrapper, so its region and
   * heading are owned by `ScoreboardDisplay`. Reuse the scoreboard page
   * object's accessors rather than re-deriving those queries here. The hero is
   * the only named region on the page, so screen-level scoping resolves to it.
   */
  scoreboard: scoreboardPage.within(screen),
};
