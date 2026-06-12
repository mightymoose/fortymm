import { FormRow } from "./recent-form/form-row";
import { type RecentFormView } from "../../players-panel-query";

export interface RecentFormProps {
  form: RecentFormView;
}

export const RecentForm = ({ form }: RecentFormProps) => (
  <div className="md-profile__form">
    <div className="md-kicker">
      {form.kind === "history" ? form.kicker : "Form"}
    </div>
    {form.kind === "empty" ? (
      <div className="md-profile__empty">{form.emptyText}</div>
    ) : (
      <>
        <div className="md-profile__form-summary">{form.summary}</div>
        <ul className="md-profile__form-list">
          {form.rows.map((row) => (
            <FormRow key={row.matchId} result={row} />
          ))}
        </ul>
      </>
    )}
  </div>
);
