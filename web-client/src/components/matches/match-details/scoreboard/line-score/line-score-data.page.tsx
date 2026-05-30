import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, type HttpResponseResolver } from "msw";
import { server } from "@/mocks/server";
import { LineScoreData } from "./line-score-data";
import { linePage } from "./line-score-data/line-score-data-display/line.page";
import { lineScoreGridPage } from "./line-score-data/line-score-data-display/line-score-grid.page";

const LOADING_TESTID = "line-score-data-loading";

export const lineScoreDataPage = {
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
                    <LineScoreData matchId={matchId} />
                </Suspense>
            </QueryClientProvider>,
        );
    },

    get isLoading() {
        return screen.queryByTestId(LOADING_TESTID) !== null;
    },

    /**
     * Resolves once the fetched line score has rendered. The grouped grid is
     * also rendered by the loading skeleton, so we wait on the first real
     * game-column label ("G1") instead — only the loaded grid labels its
     * columns.
     */
    settle() {
        return screen.findByText("G1");
    },

    // The display is built from the grid shell + one row per side, so reads go
    // through their page objects — exercising the real select() transform end
    // to end.
    grid: lineScoreGridPage,
    line: linePage,
};
