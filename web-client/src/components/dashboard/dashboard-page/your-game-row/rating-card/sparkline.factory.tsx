import type { SparklineProps } from './sparkline'

/** A rising five-point fluid sparkline. */
export function buildSparklineProps(
  overrides: Partial<SparklineProps> = {},
): SparklineProps {
  return {
    data: [1500, 1530, 1560, 1588, 1612],
    fluid: true,
    ...overrides,
  }
}
