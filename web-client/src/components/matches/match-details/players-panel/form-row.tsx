import { cn } from "@/lib/utils";

import { type FormRowView } from "./players-panel-query";

export interface FormRowProps {
  result: FormRowView;
}

export const FormRow = ({ result }: FormRowProps) => (
  <li className="md-form-row">
    <span
      className={cn(
        "md-form-row__badge",
        result.won ? "md-form-row__badge--w" : "md-form-row__badge--l",
      )}
    >
      {result.won ? "W" : "L"}
    </span>
    <span className="md-form-row__opp" title={result.opponentLabel}>
      <span className="md-form-row__opp-name">{result.opponentLabel}</span>
      <span className="md-form-row__when">{result.dateLabel}</span>
    </span>
    <span
      className={cn(
        "md-form-row__score",
        !result.won && "md-form-row__score--loss",
      )}
    >
      {result.scoreLabel}
    </span>
  </li>
);
