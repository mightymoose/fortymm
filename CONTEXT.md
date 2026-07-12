# fortymm

Table-tennis match tracking and rating. This glossary captures the project's
ubiquitous language. It is a glossary only — not a spec — and is kept free of
implementation detail.

## Match result negotiation

**Match**:
A contest between two sides, played as a best-of-`N` set of games. A side wins by
taking a majority of the games.

**Scratchpad**:
The shared, server-held score board for a match before any result is claimed —
the canonical board *state*, editable by either participant one game at a time,
and the same board on every client and platform. It freezes the moment the first
result is proposed. "Shared" is about *authority and editability*, not live
delivery: a change one participant saves is authoritative immediately, but other
open views only reflect it on their next fetch (see **Live spectating**).
_Avoid_: draft, working board, local board.

**Spectator**:
Anyone viewing a match who is not one of its two participants — a signed-in
onlooker or an anonymous holder of the share URL. A spectator reads the board
but can never edit the scratchpad, propose, or accept.
_Avoid_: viewer, observer, watcher.

**Live spectating**:
The (not-yet-built) capability of a participant's or spectator's open view
updating to show scratchpad changes *as they are saved*, without a manual
reload. It is a separate concern from the scratchpad being shared: the board can
be shared and authoritative server-side while no client refreshes in real time.
Today only a posted-but-unaccepted result is polled; an in-progress scratchpad
is not, on any platform.
_Avoid_: live scores, real-time scoring (when you mean the shared board itself —
that is the **Scratchpad**).

**Decided board**:
A complete, legal set of games — contiguous from game one, every game a legal
table-tennis score, ending the instant one side clinches the majority (no games
recorded after the decider). Every result must describe a decided board.
_Avoid_: finished score, final board.

**Overrun**:
A board with a game scored *past* the decider — some side clinched the majority,
yet a later game is also recorded. Not a decided board, and never healed into
one: every surface refuses it (the score-entry page blocks the save, the propose
endpoint 422s) and the fix is to clear the games after the decider, not to drop
them silently. Distinct from an empty *gap*, which compaction closes harmlessly.
_Avoid_: extra games, overflow, trailing games.

**Result**:
A claim about how a match ended — a decided board that one participant puts
forward for the other to agree to. Frozen when proposed; never edited in place.

**Standing result**:
The current result on the table — the one a participant can accept or counter.
There is at most one per match at any time.
_Avoid_: latest result, current proposal.

**Propose**:
To put a result forward. Covers the first claim, revising one's own claim, and
countering the other side's claim — all the same act. A propose that revises an
existing standing result is a correction.

**Accept**:
The opposing side agreeing to the standing result. Accepting is the only consent
the other side gives; it completes the match. There is no separate "confirm".
_Avoid_: confirm, sign off.

**Correction**:
A proposed result that supersedes the standing one — a full re-score of the
decided board, not an edit of individual game cells. The corrector may add,
remove, or change games, so long as the outcome is again a decided board.
_Avoid_: dispute, edit, amendment.

**Retirement**:
The auto-acceptance of a **standing result** when the side that owes a response
lets its **retirement window** lapse. Silence resolves the negotiation in favour
of the standing result: it becomes accepted and the match completes, exactly as
a manual **accept** would. Named for the racket-sport walkover — the
non-responding side forfeits its turn by not taking it — and deliberately
distinct from the injury sense of "retire" (a player stopping mid-play).
_Avoid_: timeout, expiry, forfeit, walkover, auto-confirm.

**Retirement window**:
The span a side has to accept or counter the standing result before
**retirement** auto-accepts it. Measured from the moment the standing result was
proposed — a **correction** or any supersede starts a fresh window against
whichever side then owes the review. Configured on the match's settings so a
tournament or club template can shorten, lengthen, or disable it; a disabled
window (none) restores the plain negotiation that never auto-resolves.
_Avoid_: deadline, SLA, grace period, expiry.

## Match taxonomy

**Game**:
One leg of a **match** — a single race to `games_to_win` points. A match is a
best-of-`N` run of games and is won by taking a majority of them. The unit is
always a game, never a set: table tennis has games, tennis has sets.
_Avoid_: set, leg, frame (the API's `PlayerMatchRow.sets` field was a misnomer and
was renamed to `games`).

**Rating**:
A player's skill number in a league, moved only by **rated matches**. A player who
has never finished a rated match has no rating ("Unrated" on their profile). Copy
about "no rated matches yet" is correct when it is talking about *rating* — never
when it is talking about a player's **match history**, which counts every kind of
match.
_Avoid_: score, rank, ELO (the number is a rating).

**Rated match**:
A match played for rating: it moves both players' **rating** when it completes.
Always has a real opponent (you cannot play a rated match against nobody), and it
completes only once the opposing side **accepts** the result.
_Avoid_: ranked match, competitive match.

**Unrated match**:
A match that does not touch anyone's **rating**. May still have a named opponent
(a friendly), or none at all (a **solo match**). Completes as soon as a result is
recorded — there is no second party whose sign-off is worth waiting on.
_Avoid_: casual match, friendly (a friendly is one *kind* of unrated match, not a
synonym).

**Solo match**:
An unrated match with no opponent — the player records their own games against a
player-less second side. Rendered as "No opponent" in a match list, and always
unrated (a rated match needs an opponent). Its empty second side is a structural
sentinel, not an absence to be filtered away.
_Avoid_: practice match, single-player match, self match.

**Match history**:
Every match a player was on a side of — regardless of rating, opponent, or
outcome — newest first. It is *not* a rated-play record: it includes unrated,
solo, and still-in-progress matches. Contrast with **rating**, which is
rated-only. This distinction is the whole point of issue #845: a player with an
empty history "has no matches yet", not "no *rated* matches yet".
_Avoid_: results, rated history, match log.

**Voided match**:
A match that was played and is still remembered, but which no longer counts: it
is terminal, closed to new proposals, shown as "Voided", and contributes nothing
to anyone's **rating**. Voiding a match deletes its rating history — a voided
match is absent from the **rating timeline**, not merely skipped by it. Distinct
from an **unrated match**, which never counted in the first place, and from a
deleted match, which is not remembered at all.
_Avoid_: cancelled match, annulled match, disputed match (that status is retired).

## Rating recompute

**Rating timeline**:
The ordered sequence of a league's completed **rated matches**, against which
every player's **rating** is a pure function. Ordered by each match's *completion*
instant — stable, stamped once, and never moved by a later edit — not by when its
rows were last written. A player's rating is whatever replaying the timeline from
their initial state produces; a player whose timeline is empty sits at the
strategy's initial state.
_Avoid_: rating log, history (that is the audit table, `rating_history`).

**Recompute**:
Rebuilding a league's rating state from the **rating timeline** after something
upstream disturbs it (an account **merge**, a **voided match**). Deterministic and
idempotent: it reads current state and rewrites it, so a retry lands on the same
answer. Runs one league at a time, in the background.
_Avoid_: recalculation, rating rebuild, backfill.

## Leagues

**League**:
A population of players who share one rating ladder. It is the unit a **rating**,
a **rank**, and a **rating timeline** are scoped to — there is no such thing as a
player's rating *in general*, only their rating *in a league*. A player may belong
to several leagues at once and carries an independent rating in each. A **match**
is played in exactly one league.
_Avoid_: club, ladder, division, season (a league is none of these; it is the
rating scope).

**Default league**:
The one league every player is joined to on sign-up, and the league a surface
falls back to when the caller names none. Exactly one exists.
_Avoid_: home league, main league, global league.

## Player profile

**Career**:
A player's lifetime record across *every* league they play in: matches decided,
wins, losses, win rate, **games won**, and **streaks**. Career is a fact about the
person, not about a ladder — unlike **rating**, **rank**, **peak rating**, and
**rating confidence**, which are all league-scoped. A career total counts only
**decided** matches (a win or a loss); it is therefore a smaller number than the
player's **match history**, which also counts matches still in play.
_Avoid_: stats, record, lifetime rating (a career has no rating).

**Peak rating**:
The highest **rating** a player has ever held in a league. Read off the league's
**rating timeline**, so a **voided match** can lower it retroactively — a peak
reached only via a match that was later voided was never really reached.
_Avoid_: best rating, high score, all-time high.

**Rating confidence**:
How settled a player's **rating** is — how much the next match could move it.
Three levels, in order: **provisional** (a new or long-idle player; the rating is
a guess and will swing hard), **firming up**, and **settled** (a reliable read;
matches move it only a little). Its honest statement is an interval — "we think
this player is somewhere between 1551 and 1823" — not a percentage.
_Avoid_: certainty, accuracy, reliability score, confidence *percent* (there is no
such number); RD and volatility are the Glicko-2 internals *behind* confidence,
not names for it.

**Form**:
A player's most recent decided matches as a newest-first run of W's and L's. A
short-window fact — it says what is happening lately, and deliberately says
nothing about **career** or **rating**.
_Avoid_: streak (a **streak** counts *consecutive* same results; form shows the
run whatever it looks like), recent results.

**Streak**:
A run of consecutive same-outcome decided matches. **Current streak** is the run
ending at the player's most recent decided match — it breaks the moment the other
outcome lands. **Best streak** is the longest winning run they have ever put
together. Cross-league, like the rest of **career**.
_Avoid_: run, hot streak, form (see **form**).

**Games won**:
The share of individual **games** a player has taken across their decided matches
— a finer-grained read on dominance than wins and losses, which only count whole
matches. A 3–2 win and a 3–0 win are the same in the W–L column and very
different here.
_Avoid_: sets won, points won (points are not modelled), game win rate.

**Meeting**:
One decided **match** between two named players. The count of meetings and their
outcomes make up a **head-to-head**.
_Avoid_: encounter, matchup (a *head-to-head* is the record; a *meeting* is one
match in it), fixture (a **fixture** is a tournament draw's *pre-play* pairing —
a meeting is a decided match).

**Head-to-head**:
One player's record of **meetings** against another — how many times they have
played and who won. Always relative to a stated pair, and always read from a
stated side: `A 4–1 B` and `B 1–4 A` are the same head-to-head said two ways, so
copy must name whose side it is written from.
_Avoid_: H2H record vs *the field* (a head-to-head is always against one named
opponent, never against everyone).

**Cascade**:
The forward propagation of staleness through the **rating timeline**. If a
player's rating changes at match M, every later match they played is stale too,
and so is everyone they played in those matches. The cascade walks forward
chronologically, growing the set of **affected users** as it discovers them.
_Avoid_: ripple, fan-out, propagation.

**Affected user / affected match**:
A user whose rating the **cascade** has determined must be replayed, and a match
that must be replayed because at least one of its participants was already
affected when the cascade reached it. A match whose participants were *both*
unaffected is not affected — its stored rating history is already exactly what a
replay would produce, so replaying it is redundant.

**Seed**:
The rating state an **affected user** is replayed *from*: their state as of the
instant just before **their own** first affected match — not before some global
cutoff. Seeding every user from one shared cutoff is what issue #749 describes:
a user who joins the **cascade** late loses any intervening match that the
cascade never replayed.
_Avoid_: baseline, starting rating, initial state (that is the strategy's, and
is what a player with an empty timeline seeds to).

**Self-play collision**:
The discovery, at **merge** time, that the **guest** and the **claimed account**
they are merging into sat on *opposite sides of the same match* — proving both
sides were always the same person. The match is transferred wholly to the claimed
account and then **voided**: it is kept as a record but stops counting. Not an
error, and never a reason to refuse the merge.
_Avoid_: duplicate player, self match (a **solo match** is a different thing).

## Session and identity

**Guest**:
An ephemeral, email-less account minted automatically on first contact so
anyone can start playing without signing up. Identified only by the browser's
session cookie; disposable, and folded into a claimed account when the holder
later signs in (a merge).
_Avoid_: anonymous user, ephemeral user (use "guest" in product language).

**Claimed account**:
A user who has attached a confirmed email, giving them a durable identity that
outlives any one browser session and can be signed back into on another device.
The opposite pole from a guest.
_Avoid_: registered user, real account.

**Sign out**:
Discarding the session cookie for the current browser origin, abandoning the
current identity. The cookie is shared across every tab on the origin, so
signing out in one tab ends the session for all of them — not just the tab that
did it.
_Avoid_: log out (button copy may say "Log out"; the act is "sign out").

**Session-ended**:
The state a tab lands in when its session cookie no longer resolves to a usable
user — the holder signed out elsewhere, or was merged away. The app's response
is to drop the stale identity and send the holder to sign in, never to quietly
mint a fresh guest in their place.
_Avoid_: logged out, expired, unauthenticated.

## Players roster

**Rank**:
A player's position on a league's rating ladder — rank 1 is the highest-rated
player in the league. It is a *global* fact about the player within a league:
the same no matter how the roster is searched, sorted into pages, or otherwise
windowed. Computed by standard competition ranking — your rank is one more than
the number of players *strictly* above you by rating, so equal-rated players
share a rank and the next rank skips (…, 7, 7, 9, …). A player with **no rating**
(never finished a rated match) has **no rank** at all — not a large number at the
bottom of the list.
_Avoid_: seed, top seed, position, row number (the roster's leftmost column may
be *styled* with tournament "seed" flavor, but the underlying concept is a
rating rank, never the player's index on the current page).

## Tournaments

**Draw**:
The complete set of **fixtures** an event's draw type prescribes for its
entrants — a bracket, a set of pools, or (later) rounds of pairings. A draw is
**cut** (the deliberate, reviewable act of generating it; re-cutting replaces
it wholesale and is refused once there is any evidence of play), and it is
**current** when its fixtures cover exactly the event's active entrants —
an entry landing after the cut makes the draw **stale**. Going live requires
every event's draw to exist and be current; a draw may be cut and re-cut
freely before that.
_Avoid_: bracket (one draw type's shape, not the general concept), schedule
(when a fixture is *played* is the schedule's concern, not the draw's).

**Fixture**:
A planned pairing in a **draw**: a round and a position (and a **pool**, when
the draw is pooled), whose sides may still be unknown. A fixture is not a
**match** — it *materializes* into one the moment both of its sides are known,
and the match then runs the normal propose/accept lifecycle. A fixture is
**pending** (some side still unknown), **ready** (both sides known — its match
exists), or **decided** (its match completed and the winner recorded on the
fixture).
_Avoid_: slot (a *Slot* is a window of time), tournament match (a fixture is
the pre-play pairing; the match is the contest it becomes), tie.

**Pool**:
One concept with two faces, deliberately not split: a reserved slice of the
venue (a set of tables for a window of time) *and*, once a round-robin draw is
cut, the group of entrants who play all-play-all on that slice. The set of pools
an event has is frozen the moment a draw exists — pools can no longer be added,
removed, or renamed — but a pool's venue attributes (its tables, its time
window) stay editable mid-event, because the venue changes under a running
tournament (a table breaks, a table frees up).
_Avoid_: group (a pool is not a grouping abstraction separate from the venue
slice), division.

## Dashboard

**First-match**:
The dashboard state for a player with no completed matches and nothing in
play — no match currently needs scoring, reviewing, or a result accepted. A
player with an unfinished match is not first-match, even at zero completed
matches: that match's own dashboard treatment takes priority so it is never
hidden behind a "log your first match" prompt.
_Avoid_: zero state, empty dashboard, new user.

**Actionable**:
An open match that is waiting on *the current user's* own move, as opposed to
one merely parked on someone else. There are two actionable buckets — **review**
(the opponent proposed the standing result; the user must accept or counter) and
**score** (an in-progress match with no standing result; the user can still
enter games). The passive counterparts fold into a waiting count, never a row:
**waiting-on-opponent** (the user proposed the standing result) and
**waiting-on-others** (a pending/scheduled match). "Actionable" is
current-user-relative: the proposer and the reviewer of the *same* result sit on
opposite sides of it. Rank order is review-before-score, rated score before
unrated, oldest-first within a bucket. The same definition backs the dashboard's
"Needs your attention" panel and the match list's Attention tab, so they can
never disagree.
_Avoid_: dispute (there is no `disputed` status — a contested result is a
**Correction**), needs-attention (that names the panel, not the per-match
property).
