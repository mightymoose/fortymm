import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { matchDetails } from "@/test/factories";

import { matchDetailsPage } from "./match-details.page";

/**
 * The match-details page suite. The page is now an assembly of self-fetching
 * section quartets (scoreboard, callouts, players, ratings, head-to-head,
 * breadcrumb, …), each with its own exhaustive tests; what lives here is the
 * page-level wiring — that the page projects a payload into the right sections
 * and that the seams between them hold. Exhaustive per-section behaviour lives
 * in each quartet's own tests.
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

describe("MatchDetails — confirmation-callout seam", () => {
  it("renders the confirmation callout when it's the viewer's turn", async () => {
    // Wiring only: callout content and the accept flow are pinned by the
    // confirmation-callout quartet's own tests.
    matchDetailsPage.mockMatch("m-1", {
      ...decidedMatch(),
      status: "in_progress",
      status_label: "Awaiting acceptance",
      negotiation: {
        viewer_state: "review",
        your_turn: true,
        standing_result: {
          id: "r-1",
          games: [{ game_number: 1, side_1_points: 11, side_2_points: 7 }],
          submitted_by: "u-opp",
          submitted_at: "2026-06-10T12:00:00Z",
        },
        prior_result: null,
        diff: null,
      },
    });

    matchDetailsPage.render("m-1");

    await waitFor(() =>
      expect(
        matchDetailsPage.confirmationCallout.getCallout(),
      ).toBeInTheDocument(),
    );
  });
});

describe("MatchDetails — finalize-callout seam", () => {
  it("renders the finalize callout for a finalizable board", async () => {
    // Wiring only: callout content and the post flow are pinned by the
    // finalize-callout quartet's own tests.
    matchDetailsPage.mockMatch("m-1", {
      ...decidedMatch(),
      status: "in_progress",
      status_label: "Live",
      can_finalize: true,
      games: [
        {
          id: "g1",
          game_number: 1,
          score: {
            id: "s1",
            side_1_points: 11,
            side_2_points: 4,
            winner_side_number: 1,
          },
        },
      ],
    });

    matchDetailsPage.render("m-1");

    await waitFor(() =>
      expect(matchDetailsPage.finalizeCallout.getCallout()).toBeInTheDocument(),
    );
  });
});

describe("MatchDetails — scoreboard seam", () => {
  it("wraps the hero in a region named by the live scoreboard outcome", async () => {
    matchDetailsPage.mockMatch("m-1", decidedMatch());

    matchDetailsPage.render("m-1");

    // ScoreboardDisplay names the hero <section> from the selected outcome —
    // an accessible name the old bare <section className="md-hero"> never had.
    await waitFor(() =>
      expect(matchDetailsPage.scoreboard.getHeading()).toHaveTextContent(
        "me defeated nguyen.t by 3 games to 1",
      ),
    );
    expect(
      matchDetailsPage.scoreboard.getRegion(),
    ).toHaveAccessibleName("me defeated nguyen.t by 3 games to 1");
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

describe("MatchDetails — page wiring", () => {
  it("renders the hero scoreline from the participant sides counts", async () => {
    const match = matchDetails({
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
    matchDetailsPage.mockMatch("m-1", match);

    const { container } = matchDetailsPage.render("m-1");

    // Wait for the hero to render; each side's games_won shows up as the
    // headline score number, current-user side on the left.
    await waitFor(() =>
      expect(container.querySelector(".md-hero__name")).toHaveTextContent("me"),
    );
    const leftScore = container.querySelector(".md-hero__score--l");
    const rightScore = container.querySelector(".md-hero__score--r");
    expect(leftScore).toHaveTextContent("3");
    expect(rightScore).toHaveTextContent("1");
    // My side won — the win modifier is on the left, not the right.
    expect(leftScore).toHaveClass("md-hero__score--win");
    expect(rightScore).not.toHaveClass("md-hero__score--win");
  });

  // The header "Score" CTA lives in the self-fetching `ScoreCta` quartet — see
  // score-cta-query.test.ts (the can_score / current_game projection),
  // score-cta-display.test.tsx (the link target), and score-cta-fetcher.test.tsx
  // (the fetch → display handoff and null-projection bail). The no-opponent and
  // spectator cases below still assert the CTA's presence/absence as incidental
  // page-level wiring.

  it("links each scored game cell on my row to its scores/edit route", async () => {
    const match = matchDetails({
      id: "m-4",
      status: "in_progress",
      status_label: "Live",
      best_of: 5,
      games_to_win: 3,
      sides: [
        {
          side_number: 1,
          players: [{ user_id: "u-me", username: "me", is_current_user: true }],
          games_won: 1,
          won: null,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: "u-opp", username: "opp", is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [
        {
          id: "g-1",
          game_number: 1,
          score: {
            id: "s-1",
            side_1_points: 11,
            side_2_points: 4,
            winner_side_number: 1,
            version: 1,
          },
        },
        { id: "g-2", game_number: 2, score: null },
      ],
      current_game: { game_number: 2 },
      can_score: true,
    });
    matchDetailsPage.mockMatch("m-4", match);

    matchDetailsPage.render("m-4");

    await screen.findByRole("link", { name: "Score" });
    // The first-game cell on my row is a link to the edit route for game 1.
    const editLink = await screen.findByRole("link", { name: "11" });
    expect(editLink).toHaveAttribute(
      "href",
      "/matches/m-4/games/1/scores/edit",
    );
  });

  // The error-boundary fallback (404 not-found, #152 malformed-id no-leak, and
  // the #514 429 retry path) is owned by the `MatchDetailsError` quartet — see
  // match-details/match-details-error.test.tsx.

  it('renders no-opponent matches with a "No opponent" placeholder, still scorable', async () => {
    const game1 = { id: "g-solo-1", game_number: 1, score: null };
    const match = matchDetails({
      id: "m-solo",
      sides: [
        {
          side_number: 1,
          players: [{ user_id: "u-me", username: "me", is_current_user: true }],
          games_won: 0,
          won: null,
          is_current_user_side: true,
        },
        // The sentinel opponent: a real side row with no player.
        {
          side_number: 2,
          players: [],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [game1],
      current_game: { game_number: 1 },
      can_score: true,
    });
    matchDetailsPage.mockMatch("m-solo", match);

    const { container } = matchDetailsPage.render("m-solo");

    // The participant shows on the left; the player-less opponent side renders
    // a "No opponent" placeholder rather than a blank slot.
    await waitFor(() =>
      expect(container.querySelectorAll(".md-hero__name").length).toBe(2),
    );
    const heroNames = Array.from(
      container.querySelectorAll(".md-hero__name"),
    ).map((el) => el.textContent);
    expect(heroNames).toEqual(["me", "No opponent"]);
    // The placeholder is styled as a ghost (dashed avatar + muted name), not a
    // real player.
    expect(container.querySelector(".md-hero__name--ghost")).toHaveTextContent(
      "No opponent",
    );
    expect(container.querySelector(".md-avatar--ghost")).toBeInTheDocument();
    // The Players snapshot card mirrors it on the opponent side.
    expect(
      container.querySelector(".md-profile__name--ghost"),
    ).toHaveTextContent("No opponent");
    // A no-opponent match is now scorable: the Score CTA is present.
    expect(await screen.findByRole("link", { name: "Score" })).toHaveAttribute(
      "href",
      "/matches/m-solo/games/1/scores/new",
    );
    // Did not bounce to the list.
    expect(screen.queryByText("matches-list")).not.toBeInTheDocument();
  });

  it("renders for spectators (no current-user side) without a Score CTA", async () => {
    const match = matchDetails({
      id: "m-spec",
      status: "in_progress",
      status_label: "Live",
      sides: [
        {
          side_number: 1,
          players: [
            { user_id: "u-a", username: "ada.l", is_current_user: false },
          ],
          games_won: 1,
          won: null,
          is_current_user_side: false,
        },
        {
          side_number: 2,
          players: [
            { user_id: "u-b", username: "bo.k", is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [
        {
          id: "g-1",
          game_number: 1,
          score: {
            id: "s-1",
            side_1_points: 11,
            side_2_points: 6,
            winner_side_number: 1,
            version: 1,
          },
        },
        { id: "g-2", game_number: 2, score: null },
      ],
      current_game: { game_number: 2 },
      // BFF returns false for non-participants regardless of game state.
      can_score: false,
    });
    matchDetailsPage.mockMatch("m-spec", match);

    const { container } = matchDetailsPage.render("m-spec");

    // Both player names from the match render — neither is the current user.
    await waitFor(() =>
      expect(container.querySelectorAll(".md-hero__name").length).toBe(2),
    );
    const names = Array.from(container.querySelectorAll(".md-hero__name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["ada.l", "bo.k"]);
    expect(
      screen.queryByRole("link", { name: "Score" }),
    ).not.toBeInTheDocument();
    // Scored cells stay plain divs rather than edit links for spectators.
    expect(screen.queryByRole("link", { name: "11" })).not.toBeInTheDocument();
  });

  it("shows recent form per side and an empty state for first-time players", async () => {
    const match = matchDetails({
      id: "m-form",
      status: "in_progress",
      sides: [
        {
          side_number: 1,
          players: [{ user_id: "u-me", username: "me", is_current_user: true }],
          games_won: 0,
          won: null,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: "u-rookie", username: "rookie", is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
      recent_form: [
        {
          user_id: "u-me",
          recent_results: [
            {
              match_id: "m-prev-1",
              is_win: true,
              player_games_won: 3,
              opponent_games_won: 1,
              opponent_username: "silva.r",
              completed_at: "2026-05-09T18:00:00Z",
            },
            {
              match_id: "m-prev-2",
              is_win: false,
              player_games_won: 1,
              opponent_games_won: 3,
              opponent_username: "tanaka.y",
              completed_at: "2026-05-07T18:00:00Z",
            },
          ],
          rating_before: 1612,
          rating_history: [1580, 1601, 1612],
          career_matches_before: 12,
          career_wins_before: 9,
        },
        {
          user_id: "u-rookie",
          recent_results: [],
          rating_before: null,
          rating_history: [],
          career_matches_before: 0,
          career_wins_before: 0,
        },
      ],
    });
    matchDetailsPage.mockMatch("m-form", match);

    const { container } = matchDetailsPage.render("m-form");

    // Wait for the Players snapshot card title to render. The header now
    // carries the temporal frame so the per-field labels don't have to.
    await waitFor(() =>
      expect(container.querySelector(".md-card__hd h3")).toHaveTextContent(
        "Players · going into this match",
      ),
    );
    // Wiring only: each half's content (form rows, rating box, career strip)
    // is pinned by the players-panel query and component tests. Here we prove
    // the panel projected *this* payload — my history half and the rookie's
    // empty half, side by side.
    expect(
      screen.getByText("12 prior matches · 75% win rate going in"),
    ).toBeInTheDocument();
    expect(screen.getByText(/No prior matches yet/)).toBeInTheDocument();
  });

  it("shows the head-to-head card with prior meetings counted per side", async () => {
    const match = matchDetails({
      id: "m-h2h",
      status: "in_progress",
      sides: [
        {
          side_number: 1,
          players: [{ user_id: "u-me", username: "me", is_current_user: true }],
          games_won: 0,
          won: null,
          is_current_user_side: true,
        },
        {
          side_number: 2,
          players: [
            { user_id: "u-opp", username: "opp", is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
      head_to_head: {
        total_meetings: 3,
        side_1_wins: 2,
        side_2_wins: 1,
        recent_meetings: [
          {
            match_id: "m-h2h-3",
            completed_at: "2026-05-08T18:00:00Z",
            side_1_games_won: 1,
            side_2_games_won: 3,
            winner_side_number: 2,
            rated: true,
          },
          {
            match_id: "m-h2h-2",
            completed_at: "2026-04-30T18:00:00Z",
            side_1_games_won: 3,
            side_2_games_won: 0,
            winner_side_number: 1,
            rated: true,
          },
          {
            match_id: "m-h2h-1",
            completed_at: "2026-04-12T18:00:00Z",
            side_1_games_won: 3,
            side_2_games_won: 2,
            winner_side_number: 1,
            rated: false,
          },
        ],
      },
    });
    matchDetailsPage.mockMatch("m-h2h", match);

    const { container } = matchDetailsPage.render("m-h2h");

    await waitFor(() => {
      const headings = Array.from(
        container.querySelectorAll(".md-card__hd h3"),
      );
      expect(headings.map((h) => h.textContent)).toContain("Head to head");
    });
    const h2hCard = container.querySelector(".md-h2h")!;
    expect(screen.getByText("3 MEETINGS")).toBeInTheDocument();
    // Win counts: left = me = 2, right = opp = 1.
    const counts = h2hCard.querySelectorAll(".md-h2h__count");
    expect(counts[0]).toHaveTextContent("2");
    expect(counts[1]).toHaveTextContent("1");
    // Three rows, newest first; the loss row gets the L marker.
    const rows = h2hCard.querySelectorAll(".md-h2h__row");
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector(".md-h2h__result--l")).not.toBeNull();
    expect(rows[1].querySelector(".md-h2h__result--w")).not.toBeNull();
  });

  it("shows the rating change card when ratings moved", async () => {
    const match = matchDetails({
      id: "m-rated",
      status: "completed",
      status_label: "Final",
      affects_rating: true,
      sides: [
        {
          side_number: 1,
          players: [{ user_id: "u-me", username: "me", is_current_user: true }],
          games_won: 3,
          won: true,
          is_current_user_side: true,
          rating_change: { before: 1500, after: 1512, delta: 12 },
        },
        {
          side_number: 2,
          players: [
            { user_id: "u-opp", username: "opp", is_current_user: false },
          ],
          games_won: 1,
          won: false,
          is_current_user_side: false,
          rating_change: { before: 1500, after: 1488, delta: -12 },
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
    });
    matchDetailsPage.mockMatch("m-rated", match);

    const { container } = matchDetailsPage.render("m-rated");

    await waitFor(() => {
      const headings = Array.from(
        container.querySelectorAll(".md-card__hd h3"),
      );
      expect(headings.map((h) => h.textContent)).toContain(
        "Result · rating change",
      );
    });
    const rows = container.querySelectorAll(".md-rating-row");
    expect(rows).toHaveLength(2);
    const [winnerRow, loserRow] = Array.from(rows);
    expect(
      winnerRow.querySelector(".md-rating-row__delta-num"),
    ).toHaveTextContent("+12");
    expect(winnerRow.querySelector(".md-rating-row__delta-num")).toHaveClass(
      "md-delta-up",
    );
    expect(
      loserRow.querySelector(".md-rating-row__delta-num"),
    ).toHaveTextContent("-12");
    expect(loserRow.querySelector(".md-rating-row__delta-num")).toHaveClass(
      "md-delta-down",
    );
  });

  it("hides the rating change card when no ratings have moved", async () => {
    const match = matchDetails({
      id: "m-unrated",
      status: "completed",
      affects_rating: false,
    });
    matchDetailsPage.mockMatch("m-unrated", match);

    const { container } = matchDetailsPage.render("m-unrated");

    await waitFor(() =>
      expect(container.querySelector(".md-card__hd h3")).toBeInTheDocument(),
    );
    const headings = Array.from(container.querySelectorAll(".md-card__hd h3"));
    expect(headings.map((h) => h.textContent)).not.toContain(
      "Result · rating change",
    );
  });

  it("hides the rating change card while the match is still live", async () => {
    // A live match may carry seeded/projected ratings; surfacing them in a
    // "result" card mid-match contradicts the pre-match snapshot panel, so the
    // card stays hidden until the match is Final.
    const match = matchDetails({
      id: "m-live-rated",
      status: "in_progress",
      status_label: "Live",
      affects_rating: true,
      sides: [
        {
          side_number: 1,
          players: [{ user_id: "u-me", username: "me", is_current_user: true }],
          games_won: 1,
          won: null,
          is_current_user_side: true,
          rating_change: { before: 1500, after: 1512, delta: 12 },
        },
        {
          side_number: 2,
          players: [
            { user_id: "u-opp", username: "opp", is_current_user: false },
          ],
          games_won: 0,
          won: null,
          is_current_user_side: false,
          rating_change: { before: 1500, after: 1488, delta: -12 },
        },
      ],
      games: [],
      current_game: null,
      can_score: false,
    });
    matchDetailsPage.mockMatch("m-live-rated", match);

    const { container } = matchDetailsPage.render("m-live-rated");

    await waitFor(() =>
      expect(container.querySelector(".md-card__hd h3")).toBeInTheDocument(),
    );
    const headings = Array.from(container.querySelectorAll(".md-card__hd h3"));
    expect(headings.map((h) => h.textContent)).not.toContain(
      "Result · rating change",
    );
    expect(container.querySelector(".md-rating-row")).toBeNull();
  });
});
