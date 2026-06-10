import { useId } from "react";

import { Overline } from "@/components/overline";

import { InfoRow } from "./info-row";
import { type MatchInfoView } from "./match-info-query";

export interface MatchInfoDisplayProps {
  info: MatchInfoView;
}

export const MatchInfoDisplay = ({ info }: MatchInfoDisplayProps) => {
  const id = useId();

  return (
    <section className="md-card" aria-labelledby={id}>
      <div className="md-card__hd">
        <Overline as="h3" id={id}>
          Match info
        </Overline>
      </div>
      <dl className="md-card__body">
        {info.rows.map((row) => (
          <InfoRow key={row.label} row={row} />
        ))}
      </dl>
    </section>
  );
};
