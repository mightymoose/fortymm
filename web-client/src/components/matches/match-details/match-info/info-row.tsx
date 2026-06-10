import { type InfoRowView } from "./match-info-query";

export interface InfoRowProps {
  row: InfoRowView;
}

/** One label/value line of the match-info card. Rendered as a `<dt>`/`<dd>`
 * pair — the parent supplies the enclosing `<dl>`. */
export const InfoRow = ({ row }: InfoRowProps) => (
  <div className="md-info-row">
    <dt className="md-info-row__k">{row.label}</dt>
    <dd className="md-info-row__v">{row.value}</dd>
  </div>
);
