import { Badge } from "@/components/ui/badge";

export interface StatusBadgeView {
  /** The display label text (row.status_label from the API). */
  label: string;
  /** The status-tone CSS class for this row's tab, e.g. 'status-tone-live'. Pre-resolved by the projector via STATUS_TONE[tab]. */
  toneClass: string;
  /** True only for the live tab — renders the pulsing live-dot inside the badge. */
  isLive: boolean;
}

export interface StatusBadgeProps {
  status: StatusBadgeView;
}

export const StatusBadge = ({ status }: StatusBadgeProps) => {
  return (
    <Badge variant="secondary" className={`status-pill ${status.toneClass}`}>
      {status.isLive && <span className="live-dot" />}
      {status.label}
    </Badge>
  );
};
