import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LineScore } from "./line-score";
import { lineScoreDataPage } from "./line-score/line-score-data.page";
import { lineScoreSkeletonPage } from "./line-score/line-score-skeleton.page";

export const lineScorePage = {
    // LineScore reads the same match-details endpoint as LineScoreData, so reuse
    // its stub rather than restating the route here.
    mockEndpoint: lineScoreDataPage.mockEndpoint,

    render(matchId: string) {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        render(
            <QueryClientProvider client={queryClient}>
                <LineScore matchId={matchId} />
            </QueryClientProvider>,
        );
    },

    // While the match request is in flight LineScore's Suspense boundary renders
    // the LineScoreSkeleton — read it through its own page object.
    skeleton: lineScoreSkeletonPage,

    // Once the request resolves the loaded grid is exactly what LineScoreData
    // renders, so settle/grid/line come straight from its page object.
    data: lineScoreDataPage,
};
