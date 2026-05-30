import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header } from "./header";
import { headerDataPage } from "./header/header-data.page";
import { headerSkeletonPage } from "./header/header-skeleton.page";

export const headerPage = {
    // Header reads the same match-details endpoint as HeaderData, so reuse its
    // stub rather than restating the route here.
    mockEndpoint: headerDataPage.mockEndpoint,

    render(matchId: string) {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        render(
            <QueryClientProvider client={queryClient}>
                <Header matchId={matchId} />
            </QueryClientProvider>,
        );
    },

    // While the match request is in flight Header's Suspense boundary renders
    // the HeaderSkeleton — read it through its own page object.
    skeleton: headerSkeletonPage,

    // Once the request resolves the loaded strip is exactly what HeaderData
    // renders, so settle/meta/score come straight from its page object.
    data: headerDataPage,
};
