import { useId } from "react";

import { Overline } from "@/components/overline";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { type HeadToHeadView } from "./head-to-head-query";
import { MeetingRow } from "./head-to-head-display/meeting-row";

export interface HeadToHeadDisplayProps {
  headToHead: HeadToHeadView;
}

export const HeadToHeadDisplay = ({ headToHead }: HeadToHeadDisplayProps) => {
  const id = useId();
  const { leftLabel, rightLabel, totalMeetings, leftWins, rightWins } =
    headToHead;
  const hasMeetings = totalMeetings > 0;
  // Split the bar by decided meetings only — a draw-free record, so the two
  // halves always sum to 100% when anything is decided.
  const totalDecided = leftWins + rightWins;
  const leftPct = totalDecided > 0 ? (leftWins / totalDecided) * 100 : 0;
  const rightPct = 100 - leftPct;

  return (
    // `asChild` keeps the panel a labelled `<section>` landmark while the
    // shared design-system Card supplies the chrome (ring, radius, spacing) —
    // no bespoke `.md-card` classes, and no hard rule under the title.
    <Card asChild>
      <section aria-labelledby={id}>
        <CardHeader>
          <Overline as="h3" id={id}>
            Head to head
          </Overline>
          <CardAction className="self-center text-[11px] font-medium tracking-[0.08em] text-[color:var(--fg-muted)]">
            {totalMeetings} {totalMeetings === 1 ? "MEETING" : "MEETINGS"}
          </CardAction>
        </CardHeader>
        {/* `md-h2h` is content layout (the panel's own vertical rhythm), not
            card chrome — it stays. */}
        <CardContent className="md-h2h">
          <div className="md-h2h__counts">
            <div className="md-h2h__count-label md-h2h__count-label--l">
              {leftLabel}
            </div>
            <div
              className={cn(
                "md-h2h__count",
                "md-h2h__count--l",
                leftWins > rightWins && "md-h2h__count--win",
              )}
            >
              {leftWins}
            </div>
            <span className="md-h2h__sep">—</span>
            <div
              className={cn(
                "md-h2h__count",
                "md-h2h__count--r",
                rightWins > leftWins && "md-h2h__count--win",
              )}
            >
              {rightWins}
            </div>
            <div className="md-h2h__count-label md-h2h__count-label--r">
              {rightLabel}
            </div>
          </div>
          {hasMeetings ? (
            <>
              <div className="md-h2h__bar" aria-hidden="true">
                <div
                  style={{
                    width: `${leftPct}%`,
                    background: "var(--serve-500)",
                  }}
                />
                <div
                  style={{
                    width: `${rightPct}%`,
                    background: "var(--ink-500)",
                  }}
                />
              </div>
              <div>
                {headToHead.recentMeetings.map((meeting) => (
                  <MeetingRow key={meeting.matchId} meeting={meeting} />
                ))}
              </div>
            </>
          ) : (
            <div className="md-h2h__empty">
              No prior meetings — this match is the start of the rivalry.
            </div>
          )}
        </CardContent>
      </section>
    </Card>
  );
};
