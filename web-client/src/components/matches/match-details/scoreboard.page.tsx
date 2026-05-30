import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, type HttpResponseResolver } from "msw";
import { server } from "@/mocks/server";
import { Scoreboard } from "./scoreboard";
import { headerDataPage } from "./scoreboard/header/header-data.page";
import { headerSkeletonPage } from "./scoreboard/header/header-skeleton.page";
import { lineScoreDataPage } from "./scoreboard/line-score/line-score-data.page";
import { lineScoreSkeletonPage } from "./scoreboard/line-score/line-score-skeleton.page";

export const scoreboardPage = {
    mockEndpoint(resolver: HttpResponseResolver) {
        server.use(http.get("*/v1/matches/:matchId", resolver));
    },

    render(matchId: string) {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        render(
            <QueryClientProvider client={queryClient}>
                <Scoreboard matchId={matchId} />
            </QueryClientProvider>,
        );
    },

    async settle() {
        await headerDataPage.settle();
        await lineScoreDataPage.settle();
    },

    header: headerDataPage,
    lineScore: lineScoreDataPage,

    headerSkeleton: headerSkeletonPage,
    lineScoreSkeleton: lineScoreSkeletonPage,
};
