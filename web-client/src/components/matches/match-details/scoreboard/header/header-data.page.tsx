import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, type HttpResponseResolver } from "msw";
import { server } from "@/mocks/server";
import { HeaderData } from "./header-data";
import { metaPage } from "./header-data/header-data-display/meta.page";
import { matchScorePage } from "./header-data/header-data-display/match-score.page";

const LOADING_TESTID = "header-data-loading";

export const headerDataPage = {
    /**
     * Stub the match-details endpoint this boundary reads. Owns the GET + path;
     * callers pass only the resolver, so each test shapes the exact response —
     * or failure — without restating the route.
     */
    mockEndpoint(resolver: HttpResponseResolver) {
        server.use(http.get("*/v1/matches/:matchId", resolver));
    },

    render(matchId: string) {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        render(
            <QueryClientProvider client={queryClient}>
                <Suspense fallback={<div data-testid={LOADING_TESTID} />}>
                    <HeaderData matchId={matchId} />
                </Suspense>
            </QueryClientProvider>,
        );
    },

    get isLoading() {
        return screen.queryByTestId(LOADING_TESTID) !== null;
    },

    /** Resolves once the fetched header strip has rendered. */
    settle() {
        return screen.findByRole("group", { name: "Match score" });
    },

    // The display is built from Meta + MatchScore, so reads go through their
    // page objects — exercising the real select() transform end to end.
    meta: metaPage,
    score: matchScorePage,
};
