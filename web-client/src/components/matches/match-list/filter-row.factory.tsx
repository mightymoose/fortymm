import type { FilterRowProps, FilterTabView } from "./filter-row";

/** A single resolved tab descriptor — defaults to the 'All' tab with 7 matches. */
export function buildFilterTabView(
  overrides: Partial<FilterTabView> = {},
): FilterTabView {
  return {
    value: "all",
    label: "All",
    isLive: false,
    count: 7,
    ...overrides,
  };
}

/** An unfiltered filter row with all four tabs and resolved counts. */
export function buildFilterRowProps(
  overrides: Partial<FilterRowProps> = {},
): FilterRowProps {
  return {
    q: "",
    setQ: vi.fn(),
    status: "all",
    setStatus: vi.fn(),
    tabs: [
      { value: "all", label: "All", isLive: false, count: 7 },
      { value: "live", label: "Live", isLive: true, count: 2 },
      { value: "awaiting", label: "Awaiting", isLive: false, count: 1 },
      { value: "scheduled", label: "Up next", isLive: false, count: 3 },
      { value: "final", label: "Final", isLive: false, count: 1 },
    ],
    ...overrides,
  };
}
