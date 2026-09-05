# A result finalized without a player's acceptance is announced

Date: 2026-09-02
Status: accepted

Closes item 4 of #1661. Mechanism tickets: #1585, #1650. Item 6 of #1661 (#1651) rides the
same hint, see the last section.

## Context

Three paths finalize a match without the other side's acceptance:

- a solo match,
- an unrated two-player match, where the poster self-accepts (#1650),
- a tournament director's result on a match they do not play in (#1523), rated or not.

The rated path notifies the other side and asks them to accept. The three paths above notified
nobody. A player could find their match over, and their public record changed, without a
message.

`RESULT_CONFIRM` already carries one notice that asks for nothing: "Your result was accepted",
sent to the poster when the opponent accepts. A second such notice fits the same category.

## Decision

When a result is finalized on the self-accept path and the match has a second human side,
the API notifies every player who did not post it, under `RESULT_CONFIRM`, with no action
group. The poster is not told.

- Title: "Your match result was recorded".
- Body: "{winner} beat {loser} {hi}–{lo}. Games: {per-game scores}. Recorded by {poster}." When
  the poster is not a participant, the body says "Recorded by {poster}, the tournament
  director." The body ends with "It's now official."
- Link: the match page. Collapse id: `result-recorded:{match_id}`.

The notice is built and enqueued in `api/app/match_result_notifications.py`, beside the two
existing result notices, and fired from the HTTP and MCP propose adapters after the commit,
exactly where the rated path fires "Accept your match result".

### The same hint refreshes an open match screen

Every score write and every finalize already stages a `dashboard.changed` hint for each
participant. The web client now invalidates the open match's detail and score-entry queries on
that hint, not only the dashboard. A score-entry page with nothing typed takes the other side's
save into its inputs. A page with a typed score shows the existing conflict notice against the
committed score, and the player chooses. A page whose match was finalized elsewhere shows the
boundary refusal instead of a Finalize button.

## Consequences

- A player is told, once, when the director or an unrated opponent records their result. The
  message names who recorded it, the score, and links to the match.
- A director's successful per-game save, correction, or clear also notifies the players,
  naming the director and game and linking to the match. The shared score service builds
  these notices before committing and enqueues them only after a successful write, covering
  HTTP and MCP alike. Rejected writes send nothing. Players' own scratchpad writes refresh
  open screens without sending these director notices.
- A stale score-entry page can no longer save a stale version over a newer one without the
  player seeing the newer one first. The server's version guard stays as the backstop for the
  race a hint cannot outrun.
