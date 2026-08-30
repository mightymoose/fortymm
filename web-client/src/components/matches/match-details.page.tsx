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
  MatchDetails,
  MatchDetailsError,
} from "@/components/matches/match-details";

import { breadcrumbPage } from "./match-details/breadcrumb.page";
import { callStatusBannerFetcherPage } from "./match-details/call-status-banner/call-status-banner-fetcher.page";
import { confirmationCalloutPage } from "./match-details/confirmation-callout.page";
import { finalizeCalloutPage } from "./match-details/finalize-callout.page";
import { scoreboardPage } from "./match-details/scoreboard.page";

type MatchDetailsResponse = Parameters<typeof HttpResponse.json>[0];

/**
 * Test page-object for the match-details page. Builds the router + query
 * harness the page needs so typed `<Link>`s resolve, and stubs the single
 * `GET /v1/matches/:matchId` BFF endpoint the page (and its self-fetching
 * section quartets) read.
 */
export const matchDetailsPage = {
  /** Stub `GET /v1/matches/:matchId` with a `matchDetails(...)` payload. */
  mockMatch(matchId: string, match: MatchDetailsResponse) {
    server.use(
      http.get(`*/v1/matches/${matchId}`, () => HttpResponse.json(match)),
    );
  },

  render(matchId: string) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute();
    const detailsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/details",
      component: () => <MatchDetails matchId={matchId} />,
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
    // The correction-route target for the confirmation callout's
    // "Suggest correction" / "Counter" / "Edit result" links.
    const correctRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/matches/$matchId/results/new",
      component: () => <div>correction-route</div>,
    });
    // The breadcrumb's tournament crumb and the call-status banner's
    // owner-only "Open the tournament" link both target this route (#1288).
    const tournamentDetail = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tournaments/$tournamentId",
      component: () => <div>tournament-detail</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        detailsRoute,
        scoringNew,
        scoringEdit,
        matchesList,
        matchPage,
        correctRoute,
        tournamentDetail,
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

  /**
   * The "Post result" callout is rendered through the self-fetching
   * `FinalizeCallout` wrapper — reuse its page object's callout queries.
   */
  finalizeCallout: finalizeCalloutPage.within(screen),

  /**
   * The accept/counter callout is rendered through the self-fetching
   * `ConfirmationCallout` wrapper — reuse its page object's callout queries.
   */
  confirmationCallout: confirmationCalloutPage.within(screen),

  /**
   * The header breadcrumb is rendered through the self-fetching `Breadcrumb`
   * wrapper — reuse its page object's crumb queries (#1288).
   */
  breadcrumb: breadcrumbPage.within(screen),

  /**
   * The "why can't I score this yet" banner is rendered through the
   * self-fetching `CallStatusBanner` wrapper — reuse its display's queries
   * (#1288).
   */
  callStatusBanner: callStatusBannerFetcherPage.within(screen),
};
