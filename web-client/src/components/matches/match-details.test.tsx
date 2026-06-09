import { waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { matchDetails } from "@/test/factories";

import { matchDetailsPage } from "./match-details.page";

/**
 * Scoreboard-migration suite. As the strangler moves hero/scoreboard
 * functionality out of `match-details-page.tsx`, its tests land here. For now
 * this covers only the seam `scoreboard.tsx` introduced: the hero is rendered
 * through the `Scoreboard` wrapper, so `ScoreboardDisplay` now owns the
 * `<section className="md-hero">` and gives it an accessible name from the
 * scoreboard outcome. Hero *content* behaviour stays in the legacy suite until
 * it migrates; exhaustive outcome wording stays in `scoreboard-query.test.ts`.
 */

/** A decided singles match with a stable, assertable scoreboard outcome. */
const decidedMatch = () =>
  matchDetails({
    id: "m-1",
    status: "completed",
    status_label: "Final",
    sides: [
      {
        side_number: 1,
        players: [{ user_id: "u-me", username: "me", is_current_user: true }],
        games_won: 3,
        won: true,
        is_current_user_side: true,
      },
      {
        side_number: 2,
        players: [
          { user_id: "u-opp", username: "nguyen.t", is_current_user: false },
        ],
        games_won: 1,
        won: false,
        is_current_user_side: false,
      },
    ],
    games: [],
    current_game: null,
    can_score: false,
  });

describe("MatchDetails — scoreboard seam", () => {
  it("wraps the hero in a region named by the live scoreboard outcome", async () => {
    matchDetailsPage.mockMatch("m-1", decidedMatch());

    matchDetailsPage.render("m-1");

    // ScoreboardDisplay names the hero <section> from the selected outcome —
    // an accessible name the old bare <section className="md-hero"> never had.
    await waitFor(() =>
      expect(matchDetailsPage.scoreboard.getHeading()).toHaveTextContent(
        "me defeated nguyen.t, 3 games to 1",
      ),
    );
    expect(
      matchDetailsPage.scoreboard.getRegion(),
    ).toHaveAccessibleName("me defeated nguyen.t, 3 games to 1");
  });

  it("renders the hero content inside that region", async () => {
    matchDetailsPage.mockMatch("m-1", decidedMatch());

    matchDetailsPage.render("m-1");

    // Wait for the scoreboard region to resolve through the Suspense boundary.
    const region = await waitFor(() => matchDetailsPage.scoreboard.getRegion());

    // The render-prop content lands *inside* ScoreboardDisplay's section, not
    // as a sibling: the scoreline and player name resolve within the region.
    expect(
      within(region).getByText("me", { selector: ".md-hero__name" }),
    ).toBeInTheDocument();
    expect(region.querySelector(".md-hero__score--l")).toHaveTextContent("3");
    expect(region.querySelector(".md-hero__score--r")).toHaveTextContent("1");
  });

  it("renders exactly one md-hero section (ScoreboardDisplay owns it, the hero body no longer wraps its own)", async () => {
    matchDetailsPage.mockMatch("m-1", decidedMatch());

    const { container } = matchDetailsPage.render("m-1");

    await waitFor(() => matchDetailsPage.scoreboard.getRegion());
    expect(container.querySelectorAll("section.md-hero")).toHaveLength(1);
  });
});
