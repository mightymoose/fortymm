import { axisTicks, PX_PER_MIN } from '../../data/timeline'

export interface TimelineAxisProps {
  /** The visible window, in board minutes (`TimelineBoard.startMin/endMin`). */
  startMin: number
  endMin: number
}

/**
 * The boards' shared time ruler: venue wall-clock labels (ADR-0790 — naive time,
 * no timezone math) every half hour, hourly once the window is long. Purely
 * decorative to a screen reader (`aria-hidden`): every bar already says its own
 * times in words, which is the accessible form of an x-position.
 */
export const TimelineAxis = ({ startMin, endMin }: TimelineAxisProps) => (
  <div
    aria-hidden
    data-testid="timeline-axis"
    className="relative h-6 border-b border-[color:var(--border-subtle)]"
    style={{ width: (endMin - startMin) * PX_PER_MIN }}
  >
    {axisTicks(startMin, endMin).map((tick) => (
      <span
        key={tick.min}
        className="absolute bottom-0.5 border-l border-[color:var(--border-subtle)] pl-1 font-mono text-[10px] tabular-nums text-[color:var(--fg-3)]"
        style={{ left: (tick.min - startMin) * PX_PER_MIN }}
      >
        {tick.label}
      </span>
    ))}
  </div>
)
