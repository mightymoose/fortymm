import type { MetaProps } from "./meta";
import type { StatusView } from "@/components/matches/match-status-badge";

export const metaFactory = (overrides: Partial<MetaProps> = {}): MetaProps => ({
    status: { kind: "final" } satisfies StatusView,
    bestOf: 5,
    ...overrides,
});
