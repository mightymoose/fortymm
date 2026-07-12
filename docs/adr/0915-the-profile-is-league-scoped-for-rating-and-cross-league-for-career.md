# The player profile is league-scoped for rating and cross-league for career

A player's **rating**, **rank**, **peak rating**, **rating confidence**, **form**
and rating history are all facts about them *inside one league* — the schema has
said so since day one (`user_league_ratings` and `rating_history` are both keyed
on `(league_id, user_id)`). Their **career** — matches decided, W–L, win rate,
**games won**, **streaks** — is a fact about the *person*, and counts every league
they play in.

The profile page therefore carries a league in its URL (`?league=<id>`, omitted
when it's the **default league**). The whole rating half of the page follows that
selection; the career half ignores it. The Leagues card is the switcher, not a
passive list.

Today every player is in exactly one league, so none of this is visible. We are
building it now because USATT leagues are coming, and the alternative collapses
badly when they arrive.

## Considered options

- **Split the page: league-scoped rating, cross-league career (chosen).** It is
  the only split the data can actually back, and it makes the Leagues card the
  thing that explains the page rather than a row of decoration. The read path
  already takes an optional `league_id`, so the cost today is a URL param and a
  query key.
- **Scope the entire page to one league**, match history and career included.
  Rejected: it makes the page answer "who is this player *in this ladder*" and
  loses "who is this player", which is the question a profile exists to answer.
  It would also mean a player's headline W–L changes when you click a league,
  which reads as a bug.
- **Scope nothing — one global rating.** Rejected: it contradicts the schema, and
  it is precisely the thing that breaks the day a second league exists. A player
  rated 1687 in FortyMM and 1642 in USATT has no single "rating" to show.
- **Defer all of it until multi-league actually ships.** Rejected: the page would
  be rebuilt from the studs a second time, and every number on it would need
  re-deciding under time pressure rather than now.

## Consequences

Switching league refetches the profile bundle (the league is part of its query
key), because a league switch changes the hero, the confidence card, the chart
*and* the Leagues card highlight at once — a narrower per-card call would be four
calls, not one.

Every league-scoped number on the page must be able to say *which* league it is
about. "Top 8%" and "#3" are meaningless naked. The hero says "#3 of 42 in
FortyMM".

The Leagues card renders exactly one row for every real user today. That is
correct, not a bug to be optimised away by hiding the card — hiding it would
delete the only affordance that will make the page legible when the second league
lands.
