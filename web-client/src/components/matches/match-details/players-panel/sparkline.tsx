export interface SparklineProps {
  data: number[];
  w?: number;
  h?: number;
  downColor?: string;
}

/** A decorative rating-trend line; the adjacent rating value carries the
 * actual information, so the svg is aria-hidden. */
export const Sparkline = ({
  data,
  w = 110,
  h = 36,
  downColor = "var(--fg-3)",
}: SparklineProps) => {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 2;
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const path = points
    .map(
      (p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`,
    )
    .join(" ");
  // The last point's trend picks the colour so a falling rating reads as a
  // loss tone even before the user squints at the y-axis.
  const trendUp = data[data.length - 1] >= data[0];
  const color = trendUp ? "var(--serve-500)" : downColor;
  const last = points[points.length - 1];
  return (
    <svg
      width={w}
      height={h}
      style={{ display: "block", overflow: "visible" }}
      aria-hidden="true"
      data-testid="match-details-sparkline"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.4" fill={color} />
    </svg>
  );
};
