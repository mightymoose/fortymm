import type { SparklineProps } from "./sparkline";

/** Props for `Sparkline` — a rating dipping then climbing to a new high, so
 * the default trend reads up. */
export function buildSparklineProps(
  overrides: Partial<SparklineProps> = {},
): SparklineProps {
  return {
    data: [1480, 1465, 1490, 1510],
    ...overrides,
  };
}
