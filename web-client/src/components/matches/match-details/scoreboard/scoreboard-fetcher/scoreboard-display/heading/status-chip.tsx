import { Badge } from "@/components/ui/badge";
import { type StatusChipView } from "../../scoreboard-query";

export interface StatusChipProps {
  chip: StatusChipView;
}

const chipVariant: Record<
  StatusChipView["status"],
  React.ComponentProps<typeof Badge>["variant"]
> = {
  scheduled: "outline",
  live: "default",
  final: "secondary",
};

export const StatusChip = ({ chip }: StatusChipProps) => {
  return (
    <Badge role="status" variant={chipVariant[chip.status]}>
      {chip.label}
    </Badge>
  );
};
