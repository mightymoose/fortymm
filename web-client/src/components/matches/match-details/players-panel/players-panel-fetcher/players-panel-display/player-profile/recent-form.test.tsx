import {
  buildEmptyRecentFormView,
  buildHistoryRecentFormView,
} from "./recent-form.factory";
import { recentFormPage } from "./recent-form.page";

describe("RecentForm", () => {
  it("leads a history block with the W–L kicker and career summary", () => {
    recentFormPage.render({
      form: buildHistoryRecentFormView({
        kicker: "Form · 1–1",
        summary: "12 prior matches · 75% win rate going in",
      }),
    });

    expect(recentFormPage.getFormKicker("Form · 1–1")).toBeInTheDocument();
    expect(
      recentFormPage.getFormSummary("12 prior matches · 75% win rate going in"),
    ).toBeInTheDocument();
  });

  it("lists every recent result as a form row", () => {
    recentFormPage.render({ form: buildHistoryRecentFormView() });

    expect(recentFormPage.getScore("silva.r")).toHaveTextContent("3–1");
    expect(recentFormPage.getScore("tanaka.y")).toHaveTextContent("1–3");
  });

  it('falls back to a plain "Form" kicker and the first-match sentence when empty', () => {
    recentFormPage.render({
      form: buildEmptyRecentFormView({
        emptyText: "No prior matches yet — this is their first one.",
      }),
    });

    expect(recentFormPage.getFormKicker("Form")).toBeInTheDocument();
    expect(
      recentFormPage.getFirstMatchNote(
        "No prior matches yet — this is their first one.",
      ),
    ).toBeInTheDocument();
    expect(recentFormPage.queryFormList()).not.toBeInTheDocument();
  });

  it("shows no first-match sentence when history exists", () => {
    recentFormPage.render({ form: buildHistoryRecentFormView() });

    expect(
      recentFormPage.queryFirstMatchNote(/No prior matches yet/),
    ).not.toBeInTheDocument();
  });
});
