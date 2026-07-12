# 783. Tournament eligibility is evaluated only over facts we hold

Date: 2026-07-12

## Status

Accepted

## Context

Epic #595 shipped an **eligibility predicate builder**: a tournament event carries a
`predicates` JSONB array, each rule a `{id, field, op, value}` triple over
`field: Literal["age", "rating", "gender", "club"]`. The event editor renders a
rule builder for it, the event card renders the rules as chips, and the detail page
tells the player, in as many words, that **"Players must satisfy every rule to
enter."**

None of it is true. `predicates` has never been evaluated anywhere: the API
`model_dump()`s the rules in on create and echoes them back on read, and that is the
whole of its participation. Issue #783 was filed to "make the already-built
eligibility predicate builder actually gate entry" — a wiring job.

It is not a wiring job. When we went looking for the player attributes these rules
compare against, they do not exist:

* **`age`** — there is no date of birth, anywhere in the API. The `users` table is
  `id, username, email, confirmed_at, merged_into_user_id, merged_at, created_at,
  updated_at`.
* **`gender`** — no column, no table, no JSON blob. The only occurrences of the
  string "gender" in `api/app` are the tournament schema's own `Literal` and its
  docstring.
* **`club`** — not modelled. `LeagueMembership` exists, but a league is not a club
  (see CONTEXT.md, "League"), and the predicate is a bare boolean with no club id
  to test membership against.
* **`rating`** — exists, but only as `UserLeagueRating.rating_value`, keyed
  `(league_id, user_id)`. And a `Tournament` has **no league**: its docstring says,
  deliberately, "Standalone — not tied to a league." So even rating had no defined
  value for a tournament entrant.

So all four fields were unevaluatable, and the builder was authoring rules that
could never do anything. This is worse than an unimplemented feature. A director
who sets "Under 18" and reads "Players must satisfy every rule to enter" believes
their junior event is protected. It is not, and nothing tells them so. The gap is
not a missing gate; it is a **lie the UI tells on the API's behalf**.

Separately, `max_players` — an ordinary non-null `Integer` on the event — is
enforced nowhere either. The Nth+1 entrant is accepted. That half has no data-gap
problem at all.

## Decision

**A predicate may only name a fact we actually hold about a player. The rest are
removed from the vocabulary, not left to fail silently.**

Four parts.

### 1. The predicate vocabulary narrows to `rating`

`Predicate.field` becomes `Literal["rating"]`. `age`, `gender` and `club` are
removed from the schema and from the builder's field list (`PRED_FIELDS` in the web
client). They come back — with their operators — in the ticket that gives a player
a date of birth, a gender and a club to be compared against, and not before.

The illegal state becomes **unrepresentable** rather than merely unenforced: the API
refuses to *store* a rule it could not evaluate. fortymm is pre-deploy, so there is
no persisted data to migrate; the original migration is edited in place.

We considered leaving the three fields stored-but-unevaluated (the status quo, which
"changes nothing"). We rejected it: shipping capacity enforcement *alongside* three
inert rules is the moment the builder stops looking broken and starts looking
trustworthy, which makes the lie more dangerous, not less.

### 2. A tournament states the ladder that judges it

`Tournament` gains **`league_id`** — `NOT NULL`, FK to `leagues`. Every tournament
records which rating ladder its eligibility is decided on, so no read of an entry
decision has to ask "rated against *what*?".

It is **resolved at create** through the existing `resolve_league_or_default` helper:
the API accepts an optional `league_id`, and an omitted one becomes the **default
league** (CONTEXT.md, "Default league" — the league a surface falls back to when the
caller names none). It is **editable only while `draft`**: once `published`,
registration is open and eligibility is live, so swapping the ladder underneath
would silently re-judge players who have already entered — which ADR-0017's
guarded-edge lifecycle exists to prevent.

There is no league picker in the tournament editor, because there is no
`GET /v1/leagues` endpoint and exactly one league exists to pick. The column is
honest without being configurable; the picker arrives with multi-league support.

This reverses the "standalone — not tied to a league" note on the model, knowingly.
A tournament that gates entry on a rating *must* name the ladder it means, and the
draw work (#785) has to answer the same question to seed a bracket.

### 3. An unrated player passes every rating rule

A player is **unrated** on a ladder until they finish a rated match on it (or, on a
manual ladder, until they are imported). A rating rule evaluated against an unrated
player has no honest boolean answer.

**They pass.** A rule of `rating < 1500` admits a player who holds no rating at all.

⚠️ **"Unrated" is NOT `rating_value IS NULL`.** This is the trap, and it inverts this
decision if you fall into it. Minting a session joins the default league and **seeds
`rating_value = 1500`** along with an `initial` rating-history row — so a brand-new
player's `rating_value` is *already 1500*, not null. Key eligibility off the column and
`rating < 1500` **refuses every beginner from the beginners' event**: exactly the harm
this section exists to prevent, arrived at by way of the rule that was supposed to
prevent it.

The correct predicate is **`is_rated_member()`** (`app/ratings/rated.py`) — the
codebase's single definition of "not Unrated" (a non-null value, *and* a
non-`initial` rating-history row, *and* not a merged tombstone). It is the same
predicate the profile, the roster and the rank already read. Unrated → no rating →
passes every rule.

(This paragraph is a correction. The ADR as first written asserted the nullable-column
mechanism, and an implementer coding to it produced a `409 rating_ineligible` for the
very beginner the decision was written to admit. The *decision* was always right; only
its stated mechanism was wrong.)

The alternative — unrated fails every rule — locks a brand-new player out of the
**"Under 1500" beginners' event**, which is precisely the event that exists for
them. That is a real product harm, and it is the common case; a genuinely new player
is genuinely weak.

The cost is stated plainly, because it is not small: **this makes a rating cap
opt-out.** A sandbagger's optimal strategy is to never play a rated match, remain
unrated forever, and stay eligible for every capped event. We accept that, with one
mitigation: **an unrated entrant is marked as such in the entrants list**, so the
one person who can act on it — the director, who may withdraw them (#784) — can see
who took the opt-out. An invisible loophole and a visible one are different things.

### 4. Capacity is enforced under the lock that already exists

`max_players` is checked with a `COUNT(*) WHERE event_id = … AND status = 'entered'`
performed **inside the tournament row lock** that `enter_event` already takes
(`_get_tournament_for_update_or_404`, before any other read). Every entry to every
event of a tournament takes that same lock in that same order, so the count-then-
insert is already serialised and the N+1th entrant cannot race through.

Unlike the duplicate-entry guard — which is a partial unique index, and therefore
enforced by the database itself — **capacity cannot be a constraint**: it is a count
compared against a column on another table. The lock is the only thing standing
between us and an overfull event, which is why it is load-bearing and why the test
for it asserts on concurrency rather than on a single rejected request.

## Consequences

* An event's eligibility rules now mean something, and every rule the builder can
  author is one the server can decide. The builder no longer writes dead rules.
* Three predicate fields disappear from the UI. A director who wanted an age-gated
  junior event cannot express it — **and now correctly cannot**, instead of
  expressing it and being quietly ignored. The follow-up ticket for player
  attributes (date of birth, gender, club) is what returns them.
* `entered` remains derived, not stored (ADR-0016). Capacity reads the rows.
* A rating cap is bypassable by remaining unrated. Accepted, mitigated by making
  unrated entrants visible rather than by guessing a rating we do not have.
* Eligibility is computed in exactly **one** place — a server-side evaluator, shared
  by the `POST .../entries` guard and by the detail BFF that tells the page why the
  Enter control is not being offered. The client never re-derives it from the raw
  `predicates` JSON, because two implementations of a rule engine in two languages
  will drift.
