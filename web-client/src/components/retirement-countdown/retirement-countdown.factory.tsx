import type { RetirementCountdownProps } from "./retirement-countdown";

/** Milliseconds from now, as an ISO deadline — the shape the view carries. */
function isoInMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Props for `RetirementCountdown` — the default scenario is a comfortable
 * three-days-out deadline (the muted, non-urgent band). Deadlines are built
 * relative to `Date.now()` so the derived label is deterministic on the first
 * render without fake timers. */
export function buildRetirementCountdownProps(
  overrides: Partial<RetirementCountdownProps> = {},
): RetirementCountdownProps {
  return {
    deadline: isoInMs(3 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}
