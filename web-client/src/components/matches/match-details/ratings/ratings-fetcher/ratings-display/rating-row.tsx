import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { Sparkline } from "../../../sparkline";
import { type RatingRowView } from "../ratings-query";

export interface RatingRowProps {
  row: RatingRowView;
}

/** What a first rated match reads as where a "from" number would go. The player
 * held no rating going in, so the line is `Unrated → 1268` — never the seeded
 * 1500 they never had, and never a delta down from it (#952). */
const UNRATED_FROM_LABEL = "Unrated";

export const RatingRow = ({ row }: RatingRowProps) => (
  <div className="md-rating-row">
    <div
      className={cn("md-avatar", row.won ? "md-avatar--win" : "md-avatar--loss")}
    >
      {row.initials}
    </div>
    <div className="md-rating-row__text">
      <div className="md-rating-row__name">{row.username}</div>
      {/* Three states, told apart on purpose: no change at all, a rating
          ESTABLISHED by this match, or a rating MOVED by it. */}
      {row.change === null ? (
        <div className="md-rating-row__numbers">
          <span className="from">Unrated player</span>
        </div>
      ) : row.change.kind === "established" ? (
        <div className="md-rating-row__numbers" aria-label={row.change.ariaLabel}>
          <span className="from">{UNRATED_FROM_LABEL}</span>
          <ChevronRight size={11} strokeWidth={1.75} />
          <span className="to">{row.change.to}</span>
        </div>
      ) : (
        <div className="md-rating-row__numbers">
          <span className="from">{row.change.from}</span>
          <ChevronRight size={11} strokeWidth={1.75} />
          <span className="to">{row.change.to}</span>
        </div>
      )}
    </div>
    {/* The delta block belongs to a rating that MOVED. An established rating has
        nothing to be up or down from, so it gets no chip and no trend line. */}
    {row.change?.kind === "moved" && (
      <div className="md-rating-row__delta">
        {row.change.sparkline && (
          <Sparkline
            data={row.change.sparkline}
            w={80}
            h={28}
            downColor="var(--loss)"
          />
        )}
        <span
          aria-label={row.change.deltaAriaLabel}
          className={cn(
            "md-rating-row__delta-num",
            row.change.deltaUp ? "md-delta-up" : "md-delta-down",
          )}
        >
          {row.change.deltaLabel}
        </span>
      </div>
    )}
  </div>
);
