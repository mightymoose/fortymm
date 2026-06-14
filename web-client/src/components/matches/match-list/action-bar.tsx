import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export interface ActionBarProps {
  /** Number of live matches shown in the LIVE pill. */
  liveCount: number;
  /** Absolute href to the CSV export for the current filters. */
  exportHref: string;
}

export const ActionBar = ({ liveCount, exportHref }: ActionBarProps) => {
  return (
    <div className="action-bar">
      <div className="action-bar-title">Matches</div>
      <div className="action-bar-crumb">
        Across tournaments, club nights, ladder &amp; casual
      </div>
      <span className="live-pill">
        <span className="live-dot" />
        {liveCount} LIVE
      </span>
      <div className="filter-spacer" />
      <Button asChild variant="ghost" size="sm">
        <a href={exportHref} download>
          Export CSV
        </a>
      </Button>
      <Button asChild variant="default" size="sm">
        <Link to="/matches/new">+ New match</Link>
      </Button>
    </div>
  );
};
