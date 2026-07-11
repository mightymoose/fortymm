# The rating chart is a calendar window with a carry-in anchor

The profile's rating history chart plots **rating against calendar time** —
30d / 90d / 1y — not against the player's match sequence.

That choice has a cost the `rating_history` table cannot pay on its own. History
rows exist only where matches *completed*. A calendar window's left edge is
almost never a match: if your last match before the window was in February, there
is no row at "90 days ago", and a chart drawn from in-window rows alone starts at
whatever your first match in the window happened to be — making the headline
"+127 over 90 days" wrong.

So `GET /v1/players/{id}/rating-history` returns a **carry-in anchor**: the
player's rating *as of the window start*, read from the last history row at or
before it, from **outside** the requested window. The line is anchor → in-window
points → a flat run to today at the current rating (your last rated match may
have been three weeks ago; your rating today is still your rating).

## Considered options

- **Calendar axis with a carry-in anchor (chosen).** It is what "up +127 over the
  last 90 days" means, it is the mental model every rating chart uses, and the
  anchor is what makes the claim true. It shows inactivity honestly, as a flat
  run.
- **Plot rating against the player's rated-match sequence** ("your last 30 rated
  matches"). Seriously considered, and it is arguably the more *domain-native*
  axis: `CONTEXT.md` defines the **rating timeline** as an ordered sequence of
  completed rated matches, and nothing in our Glicko-2 (each match is its own
  rating period) moves a rating during idle time. It needs no anchor, no range
  tabs, and no empty-window state, and it degrades gracefully on sparse alpha
  data. Rejected on product grounds: it cannot answer "was I better in March than
  in June", and it hides inactivity, which is itself a thing a player wants to
  see.
- **Clip strictly to the window, no anchor.** Rejected: it is the version that
  quietly lies. Cheapest to build, wrong on every chart whose first in-window
  match isn't on day one.
- **Derive the anchor client-side** from a longer fetch. Rejected: it makes every
  range flip pull the player's whole history to find one number.

## Consequences

The endpoint returns a point that is not in the requested range. A future reader
finding a `completed_at` older than the window start in the response should not
"fix" it — it is the anchor, and removing it breaks the chart's headline number.

The empty window is now a first-class state, not an error: a rated player with no
matches in the last 90 days gets a **flat line at their current rating**, the
subtitle "No rated matches in the last 90 days", and a suppressed delta chip
(never `+0`). A player with no rating at all gets no chart — the card is replaced
by an "Unrated" panel, consistent with the hero.

A **voided match** disappears from the chart, because voiding deletes its rating
history rows (see `CONTEXT.md`, *Voided match*). The chart is a view of the
**rating timeline**, and a voided match is absent from it, not merely skipped.
So the chart can change shape retroactively. That is correct.

The chart is the one card on the page that owns its own query rather than
projecting from the page's BFF bundle, because a range flip must fetch only the
range. Its cache is seeded from the bundle for the initially-loaded range, so
first paint still costs one request. It is therefore also the one card that owns
its own error state — a failed range flip renders "Couldn't load that range · Try
again" inside the card and leaves the rest of the painted page alone, rather than
throwing to the route boundary the way a bundle failure does.
