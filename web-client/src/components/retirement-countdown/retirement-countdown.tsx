import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export interface RetirementCountdownProps {
  /** The absolute retirement deadline — an ISO datetime string, a `Date`, or
   * null. When null (no deadline in play) or unparseable, the countdown renders
   * nothing. */
  deadline: string | Date | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The escalating urgency band, driving both the copy and the color token. It
 * sharpens as the deadline nears: muted with days to go, `--warn` inside a day,
 * `--loss` inside the final hour and once the window has closed. */
type Tone = "normal" | "soon" | "urgent" | "expired";

function toneFor(remainingMs: number): Tone {
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= HOUR_MS) return "urgent";
  if (remainingMs <= DAY_MS) return "soon";
  return "normal";
}

const TONE_CLASS: Record<Tone, string> = {
  normal: "text-[color:var(--muted-foreground)]",
  soon: "text-[color:var(--warn)]",
  urgent: "text-[color:var(--loss)]",
  expired: "text-[color:var(--loss)]",
};

/** The remaining time as copy, coarsened to the largest useful unit (days, then
 * hours, then minutes), or the closed-window notice at/after zero. */
function labelFor(remainingMs: number): string {
  if (remainingMs <= 0) return "Time to respond has passed";
  const days = Math.floor(remainingMs / DAY_MS);
  if (days >= 1) {
    return `${days} ${days === 1 ? "day" : "days"} left to respond`;
  }
  const hours = Math.floor(remainingMs / HOUR_MS);
  if (hours >= 1) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} left to respond`;
  }
  const minutes = Math.max(1, Math.ceil(remainingMs / MINUTE_MS));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left to respond`;
}

function toTimestamp(deadline: string | Date): number {
  return deadline instanceof Date
    ? deadline.getTime()
    : new Date(deadline).getTime();
}

/**
 * A live "N days/hours left to respond" countdown to a match's retirement
 * deadline. It derives `now` in state and computes the remaining time during
 * render, ticking once a second (mirroring `ExpiresCountdown` in
 * `login-screens.tsx`) so the copy stays current without a global store. The
 * tone escalates as zero approaches. Renders nothing when there is no deadline.
 */
export const RetirementCountdown = ({ deadline }: RetirementCountdownProps) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (deadline === null) return null;
  const deadlineMs = toTimestamp(deadline);
  if (Number.isNaN(deadlineMs)) return null;

  const remainingMs = deadlineMs - now;
  const tone = toneFor(remainingMs);
  const label = labelFor(remainingMs);

  return (
    <p
      role="timer"
      aria-label={label}
      data-tone={tone}
      className={cn(
        "md-retirement-countdown mt-1.5 text-xs font-medium",
        TONE_CLASS[tone],
      )}
    >
      {label}
    </p>
  );
};
