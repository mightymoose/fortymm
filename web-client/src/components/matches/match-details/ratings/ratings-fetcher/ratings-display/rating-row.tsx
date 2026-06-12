import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { Sparkline } from "../../../sparkline";
import { type RatingRowView } from "../ratings-query";

export interface RatingRowProps {
  row: RatingRowView;
}

export const RatingRow = ({ row }: RatingRowProps) => (
  <div className="md-rating-row">
    <div
      className={cn("md-avatar", row.won ? "md-avatar--win" : "md-avatar--loss")}
    >
      {row.initials}
    </div>
    <div className="md-rating-row__text">
      <div className="md-rating-row__name">{row.username}</div>
      {row.change ? (
        <div className="md-rating-row__numbers">
          {row.change.from !== null && (
            <span className="from">{row.change.from}</span>
          )}
          <ChevronRight size={11} strokeWidth={1.75} />
          <span className="to">{row.change.to}</span>
        </div>
      ) : (
        <div className="md-rating-row__numbers">
          <span className="from">Unrated player</span>
        </div>
      )}
    </div>
    {row.change && (
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
