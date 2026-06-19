import type { SparklineProps } from './sparkline'

/** Props for `Sparkline` — a short upward rating history, its rating-card use. */
export function buildSparklineProps(
  overrides: Partial<SparklineProps> = {},
): SparklineProps {
  return { data: [1480, 1465, 1490, 1510], ...overrides }
}
