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
Proposals form one append-only chain per match and cannot be deleted. Acceptance
is recorded once on the head and retained even if a future proposal follows it.
See [proposal history](docs/adr/20260906-proposals-form-an-immutable-linear-history.md)
for the database invariants and the same-person Player merge exception.

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

## Tournament entry

**Entry**:
A competing unit's place in one tournament **event**, with one current member for
singles, two for doubles, and a variable team roster. Its identity, seed, draw
position and results survive membership changes. Soft-deleted on withdrawal, so a
player may re-enter (ADR-0016, amended by the September 6 entry-members ADR).
An entry knows **who created it**: `NULL` means the
player entered themselves, otherwise it names the director who added them
(ADR-0784). Those are the only two ways an entry comes to exist, and the second is
not a different endpoint — it is the same one, told who to enter.
_Avoid_: registration, signup, ticket (an entry is the row; *registration* is the
window it may be created in).

**Entry member**:
A Player's recorded interval of membership in an **entry**. A current member has
not left; ending membership retains the original player and join time. A Player
can enter multiple events, but holds at most one active entry per event unless a
team event explicitly allows more. These capabilities are database-only for now.

**Match lineup**:
The actual participants recorded on each side when a tournament match starts,
independent of its entries' later membership. Earlier lineups remain preserved
when a director records a complete, attributed **lineup correction** revision.
Distinct from scheduled participants and an entry's current roster.
The initial call snapshot is provisional: cancelling an untouched call before any
game or result resets it, and a later call captures a fresh lineup. Once play is
recorded, cancelling a call cannot erase the lineup.

**Director entry**:
The tournament **owner** adding a player to an event on their behalf — a phone
entry, or someone without an account yet. It runs through the *same* endpoint, the
same eligibility evaluator, the same capacity lock and the same **refusal codes** as
a player's own (ADR-0784): absent an override, a director's mistake is caught by
exactly the rules that catch a stranger's. An owner naming their *own* id is not a
director entry — that is self-registration, and it is spelled `NULL`.
_Avoid_: admin add, force add (there is no override yet — see #985).

**Entrant**:
A player holding an **active** entry — `status = entered`. The count of entrants is
always **derived from the rows**, never stored (ADR-0016): there is no `entered`
column, because a counter is a second copy of a truth that can drift from the rows
it counts.

**Registration window**:
The span in which entries may be created, which is exactly the tournament being
`published` (ADR-0017). A `draft` has not opened, a `live` one has locked, an
`archived` one has ended. Entering *and* withdrawing both obey it — **including the
director's** (ADR-0784). So once a tournament is `live` nobody can be added or
removed, not even by the owner: that is deliberate, and it is why #985 (the
override, for walk-ins and no-shows) exists.
_Avoid_: open, deadline (there is no date; the window is a function of the status).

**Eligibility**:
Whether a given player may enter a given event, decided **server-side, for that
caller**, by the event's `predicates` plus its `max_players`. It is computed in
exactly one place and shared by the guard that refuses the entry and the page that
explains why the Enter control is not offered — the client never re-derives it from
the raw rules (ADR-0783).

**Predicate**:
One eligibility rule: a `field`, an `op` and a `value`, ANDed with its siblings. A
predicate may only name a fact we actually hold about a player, so today the only
field is **rating** (ADR-0783). Age, gender and club were authorable and were never
enforceable; they are removed until a player has a date of birth, a gender and a
club to be compared against.
_Avoid_: filter, restriction, requirement (a predicate is the stored rule; the
*decision* it contributes to is the eligibility).

**Unrated entrant**:
An entrant holding no rating in the tournament's league — they have never finished a
rated match on that ladder. Note this is **not** "their `rating_value` is null": a new
player is seeded 1500 on sign-up, so unratedness is `is_rated_member()`, the same
predicate the profile and the roster read. They **pass every rating rule** (ADR-0783), because the
alternative bars a beginner from the beginners' event. This makes a rating cap
opt-out, so an unrated entrant is *marked as such* in the entrants list: the director
is the one who can act on it, and they can only act on what they can see.
_Avoid_: unranked, provisional (they hold no rating at all, not a soft one).

**Refusal code**:
The machine-readable reason an entry was refused — `already_entered`,
`registration_closed`, `event_full`, `rating_ineligible` — carried on a `409` as
`detail: {code, message}` (ADR-0968). The client switches on the **code** and owns
the copy; the server's `message` is a fallback, never a contract.
_Avoid_: error string, detail (matching on the prose is the bug this replaced).

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

**Account**:
The identity that signs in and acts. It holds login credentials and access rights;
it can exist without a Player. Historical actions belong to the acting Account.

**Player**:
A durable sporting identity with a username, matches, tournament entries and
ratings. A Player can exist without a login and can be managed by multiple Accounts.

**Management grant**:
Explicit authority for an Account to act for a Player in sporting workflows.
It does not confer authority to change other Accounts or their access.

**Primary Player**:
The Player an Account acts for in today's interface. An Account has at most one;
removing that choice does not automatically select another managed Player.

**Guest**:
An ephemeral, email-less account minted automatically on first contact so
anyone can start playing without signing up. Identified only by the browser's
session cookie. Its Player is durable. On a same-person sign-in merge, the guest
Account is tombstoned and its Player is transferred or combined into the
destination primary Player.
_Avoid_: anonymous user, ephemeral user (use "guest" in product language).

**Claimed account**:
An Account with a confirmed email, giving it a login identity that
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
user — the holder signed out elsewhere, a mailed link revoked the session, or
it was merged away. Detected on the next request. The app drops the stale
identity and persists the signed-out state across reloads and tabs, until the
holder signs in or explicitly starts a new guest. It never quietly mints a
fresh guest in their place.
_Avoid_: logged out, expired, unauthenticated.

**Account switch**:
Redeeming a mailed link in a browser already signed in to a different claimed
account. Requires explicit approval naming both accounts before the link is
consumed; cancel leaves the current account signed in and the link unused.
Distinct from a guest merge, which may require its own choice afterward.

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
entrants — a bracket, a set of **groups**, groups feeding a bracket, or **swiss**
rounds of pairings. A draw is
**cut** (the deliberate, reviewable act of generating it; re-cutting replaces
it wholesale and is refused once there is any evidence of play), and it is
**current** when its fixtures cover exactly the event's active entrants —
an entry landing after the cut makes the draw **stale**. Going live requires
every event's draw to exist and be current; a draw may be cut and re-cut
freely before that.
_Avoid_: bracket (one draw type's shape, not the general concept), schedule
(when a fixture is *played* is the schedule's concern, not the draw's).

**Fixture**:
A planned pairing in a **draw**: a round and a position (and a **group**, when
the draw is grouped), whose sides may still be unknown. A fixture is not a
**match** — it *materializes* into one the moment both of its sides are known,
and the match then runs the normal propose/accept lifecycle. A fixture is
**pending** (some side still unknown), **ready** (both sides known and **no
match yet** — the signal to create one), **materialized** (its match exists and
is being played), or **decided** (its match completed and the winner recorded on
the fixture). *Ready* is the state that ends the moment the match is created:
`advance()` is idempotent precisely because a fixture that already has a
`match_id` is no longer ready, and so is never proposed twice.
_Avoid_: slot (a *Slot* is a window of time), tournament match (a fixture is
the pre-play pairing; the match is the contest it becomes), tie.

**Swiss**:
A draw type that plays a fixed number of **rounds**, pairing each round by
current **standings** rather than by a bracket. Nobody is eliminated, and every
entrant plays every round. The round count is a required setting the director
chooses, not a number derived from the field. All rounds are **cut** up front
with their sides unknown, and `advance()` pairs each round once the previous one
is fully decided (ADR 20260805). A **rematch** is avoided where possible and
allowed as a last resort, because refusing to pair would strand a live event.
_Avoid_: monrad, ladder, league (a swiss event ends, a league runs on).

**Bye**:
The entrant left over when a **round** has an odd number of players. It is the
*absence of a fixture row*, never a row with a NULL side, so the byed entrant is
derived as the one with no fixture that round. In **swiss** it goes to the
lowest-ranked entrant who has not yet had one, and it scores as a **win worth
zero games** — the win because nobody should be punished for a scheduling
artifact, the zero games so it stays neutral on every tiebreak below the win.
_Avoid_: walkover (that is an opponent who failed to appear), forfeit, default.

**Buchholz**:
The sum of an entrant's opponents' win counts — a **swiss** tiebreak measuring
how strong a field that entrant had to beat. It ranks above game difference,
because who you played carries more information than your margin when the format
deliberately pairs you against your own score. A **bye** cuts two ways, and the
distinction matters: it adds nothing to the byed entrant's **own** sum, having
produced no opponent — but the win it scores **does** count toward the Buchholz of
whoever played that entrant, because Buchholz reads the same wins column the
standings display. A rematch counts twice, since the sum is over games played
rather than distinct opponents. Buchholz moves as the event runs: an opponent
winning a later match raises yours without you playing.
_Avoid_: strength of schedule (fine in prose, but the computed term is Buchholz),
sonneborn-berger (a different measure we do not compute).

**Venue**:
Where a tournament is played: a postal address, plus the coordinates it resolves
to. A tournament **may have no venue at all**, at every status from draft to
archived — and that is a first-class state, not missing data. It covers two
situations that need no telling apart, because nothing behaves differently:
the venue is not booked yet, and the venue is deliberately withheld (a small
tournament at somebody's home, whose address should not be pinned on a public
map). A tournament with no venue is simply never a result of a proximity
search. When a venue *is* recorded its coordinates are always known — there is
no venue whose location is a mystery.
_Avoid_: "venue TBD" as a label (it promises a venue is coming, which is false
for the withheld case — a tournament with no venue shows nothing, not a
placeholder), location (ambiguous between the address and the coordinates),
address (that is one *part* of a venue, not the whole).

**Group**:
Every **stage**'s fixtures are dealt into its own groups: a stage that
partitions its field into more than one all-play-all set holds that many
groups, and a stage that does not partition its field — a bracket, a swiss
field — has exactly one. A group's label derives from its position in its
stage's order, so a group stage's first group is "Group 1". Nothing stores a
group's name. Only a **group stage**'s groups are ever labelled, ranked, or
shown their own panel; a **knockout stage**'s group carries no director-facing
identity at all (ADR 20260823).
The set of group **identities** a stage has is frozen the moment a **draw**
exists: groups can no longer be added, removed, or re-identified, because every
**fixture** names the group it belongs to. The order is frozen with them, because
that order is what the draw was seeded against. The mapping from each group to
its **reservation** freezes too, so a reservation can no longer be added or
removed either (ADR 20260822).
A group plays in a **reservation**, and it is the reservation that **restricts**
scheduling rather than the group (ADR 20260807). A fixture that names a group is
placed on that group's reservation — its tables, inside its window — while a
fixture that names none is placed across the whole venue over its **event**'s
window. Since every stage now holds groups (ADR 20260823), a **knockout
stage**'s fixtures are confined to its own group's reservation exactly as a
group stage's are — they no longer fall to the event-wide reservation merely
for belonging to a knockout stage.
_Avoid_: the old one-word term that named a group and its **reservation**
together, which is the confusion these two entries exist to end; division,
grouping.

**Reservation**:
A set of **tables** held for a window of time. A reservation belongs to the
**event**, not to a **stage**, so both stages of a round-robin-then-knockout event
read one set of them. It carries the tables, the window, and the name a director
types.
A director may edit a reservation's name, its tables and its window **mid-event**,
and none of that is frozen by a **draw** — because the venue changes under a
running tournament (a table breaks, a table frees up), and nothing about the draw
depends on where a **group** plays. Only the set of group identities freezes.
A group plays in at most one reservation, and two groups may share one. A
reservation with no group, and a group with no reservation, are both ordinary
states of a round-robin-then-knockout event, because its **group count**
derives from its field and not from its reservations (ADR 20260822).
_Avoid_: the old one-word term (see **group**), slot (that is the reservation's
*window*, one part of it), booking, allocation.

**Freeze**:
A control the director owns but cannot use *right now*, because the resource has
moved into a state that refuses the act — a **draw** under way, a cut event's
draw type, an event's set of **group** identities. A frozen control renders disabled
with its reason stated, and the reason names the way out where one exists. It is
keyed on the resource's state, never on who is asking: a control withheld by
**permission** is hidden instead, and carries no reason at all (ADR-0015). The
client's freeze restates a server guard; the server stays the enforcement.
_Avoid_: locked, greyed out, read-only (a read-only surface is a rendering for a
viewer, which is the permission case, not this one).

**Confirm**:
The deliberate second click a director spends on an act that cannot be undone —
publishing, starting, ending, re-cutting a **draw**, deleting one. The dialog
names what the click buys rather than asking "are you sure", and the act's own
verb is on the button. Constructive, repeatable acts do not take one: the first
**cut** of a draw is unconfirmed on purpose. Unrelated to the match-negotiation
sense of the word, which does not exist — a result is **accepted**, never
confirmed.
_Avoid_: are you sure, warning, double-check.

**Stage**:
One phase of a **draw** that must finish before the next can be played. A
stage is a first-class thing the event owns, and every **fixture** belongs to
exactly one stage (ADR 20260815). Each stage is run by one single-stage draw
type: a round robin, a single elimination, or a **swiss**. Most events have
exactly one stage; a round-robin-then-knockout event has two — a **group
stage** run as a round robin, feeding a **knockout stage** run as a single
elimination. A stage's **groups** hang off it; the **reservations** they play in
hang off the event. The system derives an event's stages from its draw type; a
director never authors them, and they freeze when a draw exists. Both of a
two-stage draw's stages are **cut together** in one stroke, so the knockout
bracket exists — with its sides still unknown — from the moment the draw
does. This is the sport's own word: ITTF regulations play a "group stage",
then a "knock-out stage".
_Avoid_: round (a **round** is one layer *within* a stage), phase, leg, group
(a **group** is one set of entrants *inside* the group stage, not the stage
itself).

**Qualifier**:
An entrant who advances out of a **group** into the **knockout stage**: the top
*K* of that group's **standings**, where *K* is the event's qualifiers-per-group
setting. Qualifiers are seated into the bracket **as each group finishes**, not
when the whole **group stage** does. Within a finishing place, groups are **not
ranked against each other** — every group winner is an equal — and that freedom
is what lets the seating guarantee no first-round knockout **fixture** pairs two
entrants from the same group. The guarantee holds for two or more groups; with a
single group every knockout match is necessarily a rematch, which is the format
working as intended, not a failure of the rule.
_Avoid_: seed (a **seed** is an *input* to the draw; a qualifier is what playing
it produces), advancer, survivor, winner (that is one side of one **match**).

**Structural setting**:
One of the four numbers or choices that decide the shape of a
round-robin-then-knockout **draw**: **group count**, **group size**,
**membership**, and qualifiers per group. Each carries an **ownership** of its
own, and the four together live on the event editor's Draw structure tab, which
exists for no other **draw type** (ADR 20260808).
_Avoid_: draw config (that is the whole `draw_settings` row, of which these are
part), format, bracket settings.

**Ownership**:
Which side chose a **structural setting**'s value. `Automatic` means the system
derives it and recomputes it from its sources. `Yours` means the director typed
it, and the system stores it exactly and never changes it without being asked.
Ownership is recorded as its own mode, never read off whether a value is present,
because a derived number and a typed number look identical (ADR 20260808). A
director moves a setting between the two with a quiet `Set myself` or `Use
automatic`, and turning one manual seeds it from the value it already showed.
_Avoid_: manual/auto toggle (it is a state that is stated, not a switch that is
flipped), override, default (a **default** is a starting value, not a claim about
who owns it).

**Group count**:
How many **groups** a **stage** has, which is the number of group rows it has.
The server owns those rows and no client sends a group list (ADR 20260822,
20260823). A round-robin-then-knockout **draw**'s group stage derives its
count from the **preview field** before the **cut**: the field divided by
five, rounded up, re-materialised on every write to the event. At the cut the
server derives it once more from the real registered field, and after that
nothing recomputes it. Every other stage — a standalone round-robin's only
stage, a single-elim or swiss stage, and a round-robin-then-knockout event's
own knockout stage — holds exactly one group, always, independent of how many
**reservations** the event has (ADR 20260823). A group count creates no
reservation. Each group maps to the reservation at its position modulo the
reservation count, so eight groups across four reservations put two on each,
and a group on an event with no reservation plays in none.
_Avoid_: reservation count (a different number entirely), group total; "one
group per reservation" (true only because a non-composite event is capped at
one reservation, ADR 20260823 — the count itself no longer derives from the
reservation count at all).

**Group size**:
How many entrants play in one **group**. The system's default size is five. The
five is a count divisor, not a fill target: the derived **group count** is the
field divided by five, rounded up. The field then splits as evenly as it goes,
and the extra entrants land in the earliest groups. So 22 entrants give five
groups of 5, 5, 4, 4, 4. Sizes that differ by one are legal and are reported as
**uneven**, not as an error. When a director types the size and leaves
**group count** automatic, the typed size keeps its greedy meaning. Groups fill
to the typed size in turn, and the last group takes what is left. So 41 entrants
in typed fives leave a group of one. The app states that consequence and does
not reshape the typed number.
_Avoid_: reservation size, group capacity (a **reservation**'s **tables** are the
capacity, which is a scheduling idea, not this one).

**Preview field**:
The invented number of entrants the app reasons against before registration
closes. It is the event's player cap, or 16 when the event has no cap. Every
**structural setting** derived on the Draw structure tab is derived against it,
so the tab names which basis it used and says plainly when the 16 is a default
rather than a cap. Once the **draw** is **cut**, the real registered field
replaces it. The same invention already drives the schedule **preview**.
_Avoid_: field size on its own (it hides that these entrants do not exist),
expected entrants, projected field.

**Disagreement**:
A director's **group count** and **group size** that do not seat the **preview
field**. Six groups of five seat thirty, and a field of forty leaves ten entrants
with nowhere to go. The app keeps both numbers, states the shortfall, and offers
named resolutions. It never adds a group or enlarges one to make the arithmetic
work. A disagreement still **saves**, because the director may be mid-thought,
and it blocks the **cut**, because a cut would have to invent the answer
(ADR 20260808).
_Avoid_: error, invalid, conflict (a **conflict** is the scoring sense of the
word, and a disagreement is legal).

**Impossible competition**:
A configuration that describes matches nobody can play: a **group** of one
entrant, a **knockout stage** of one entrant, or more **qualifiers** than the
smallest group holds. Unlike a **disagreement**, it blocks saving as well as
cutting, and it is reported as the director types rather than at **cut** time.
The refusal names the real cause. #1320 records a director shown the wrong one.
The wording is the server's existing `DegenerateDraw` copy, not a second set of
words for the same conditions.
_Avoid_: invalid draw, bad configuration, degenerate (that is the exception's
name in code, not a word to show a director).

**Materialize**:
Turning a **ready** **fixture** into a real **match**: the fixture's two known
sides become the match's two sides, the event's `match_settings` (rated flag,
game count) become the match's rules, and it runs the normal propose/accept
lifecycle. Materialization happens **only once the tournament is `live`** — never
while registration is open — and going live materializes every ready fixture in
one stroke (for a round-robin, the whole group). A fixture materializes **at most
once**: its `match_id` is what makes creating the match idempotent, so an
`advance()` re-run never proposes the same match twice. Today only **singles**
events materialize (one player per side); other formats are refused.
_Avoid_: schedule, start (materializing *creates* the match; *when it is played*
is the schedule's concern).

**Results**:
How an event turned out, computed for display — a concept **universal across draw
types but shaped differently by each**: a round-robin's results are its
**standings**; a single-elimination's are its **finishes** (and its
**champion**); a round-robin-then-knockout's are **both** — its groups'
standings *and* its bracket's finishes, one per **stage**. Computed **live from
the fixtures' completed matches**, so a
**correction** or **voided match** is reflected at once — never stored, never a
snapshot. An event is **complete** when every fixture is **decided**; only then
are its results final. Each draw type computes its own results shape; the display
renders each its own way.
_Avoid_: standings (the round-robin *shape* of results, not the general concept),
score, summary.

**Standings**:
The round-robin **shape** of an event's **results**: the group's entrants ordered
by an extensible chain of tiebreakers — **wins**, then **head-to-head** when
exactly two are tied, then **game difference** (games won minus games lost), then
**games won**. Renders **live** as matches complete, not only at the end. Ordered
server-side.
_Avoid_: ranking (a **rank** is a league rating position; standings live inside one
group), league table, points diff (points are not modelled — the finest
granularity is a **game**, so it is *game* difference).

**Finish**:
The single-elimination **shape** of an event's **results**: each entrant's
**finishing position** in the bracket, derived from the **round it was
eliminated in** — champion (1st), runner-up (2nd, the final's loser), then the
semifinal losers (tied 3rd), the quarterfinal losers (tied 5th), and so on.
Same-round losers **tie**: single-elimination genuinely does not rank them
against each other, so a shared position is honest, not a missing tiebreak.
Computed **live from completed fixtures**, like all **results**. On the wire the
results block is a discriminated union tagged by shape — `standings` for a
round-robin, `finishes` for a single-elimination, `standings_then_finishes` for
a round-robin-then-knockout, which carries one of each.
_Avoid_: **placement** (that is a **match**'s spot in the **schedule** — table
and time — an unrelated concept; a finish is an *entrant*'s standing in the
bracket), standings (the round-robin shape), rank (a league rating position),
seed (a seed is an *input* to the draw; a finish is its *outcome*).

**Champion**:
The entrant atop a **complete** event's **results** — for a round-robin, first in
the **standings**; for a single-elimination, the undefeated entrant, first in the
**finishes**; for a round-robin-then-knockout, the winner of the **knockout
stage**, never the leader of a **group**. **Derived, never stored**: a
**correction** can re-crown, so the champion is always read from the current
results.
_Avoid_: winner (a **winner** is one side of one match; the champion is the whole
event's), first place.

**Schedule**:
Where and when a tournament's **matches** are played: the assignment of each
**match** to a **table** and a **wall-clock time**, within the window of its
**group**'s **reservation** — or, for a fixture with no group, within its **event**'s
own window and on any table in the tournament (ADR 20260807). It is **tournament-scoped, not
per-event** — the venue's tables are shared across events, so "two matches on one
table at once" is a cross-event fact — which is why it is its own surface rather than
a panel inside a single event's draw. A **placement** is written two ways that touch
the same fields: a director **places** a match by hand, and (a later slice) a
**scheduler** auto-packs the unplayed remainder and **recomputes it repeatedly** as
the tournament runs. A match with no table/time is **unassigned**.
_Avoid_: draw (the *pairings* are the draw; the schedule is *when they are played*),
slot (a **Slot** is a reservation's reserved time window — an input to the schedule,
not the schedule itself), bracket.

**Placement**:
One match's spot in the **schedule**: a **table** and a **predicted start time**. It
lives on the **fixture** (not the match), so it can be set before the match even
exists and survives **materialization**. The time is a real moment but a **prediction,
not a promise** — a match beginning earlier or later than its placement is normal, not
an error. It is stored as a **timezone-aware instant**, composed from the event's
wall-clock **Slot** components anchored by the event's own timezone, so "is this
placement inside its window" is answered in the event's frame. Its constraints (table
belongs to the reservation, time inside the window, no table or player
double-booked) are **not invariants** and never hard-block: a reservation's tables
and window even stay editable under a standing draw, stranding placements a later
edit outranges. They are judged as
**flags derived on read**, never silently rewritten. The one exception is the **table
itself**: a placement always names a real **table**, because a reference that resolves
to nothing is a dangling pointer rather than a state a director chose.
_Avoid_: schedule slot, booking, appointment, start time (it is a *predicted* start),
finish (a **Finish** is an *entrant*'s finishing position in a bracket's **results** —
an outcome, not a schedule cell).

**Table**:
One physical playing surface at the **venue** — what a match is actually played on,
identified by a label and the court it stands on. Tables belong to the **tournament**,
not to any one **event**, and the tournament's whole set of them is its **catalogue**.
A **reservation** *holds* a subset of the catalogue for its window; a **placement**
*names* one. The venue changes under a running tournament — a table breaks, a table
frees up — so a table can be removed from the catalogue mid-event: reservations that
held it simply stop holding it, while a **placement** standing on it blocks the removal
until the
director unplaces it.
_Avoid_: court (a table *stands on* a court; several tables may share one), board,
station, "table" for the database sense (say **catalogue** for the tournament's set).

**Pinned / free** (scheduler-era):
Once the **scheduler** exists, a **placement** is **free** — the solver may move it —
unless **pinned**: **started** (`in_progress`/`completed`, its table and time now
history) or **manually placed** by a director. The solver holds pinned placements fixed
and packs the free ones around them. Before the scheduler, every placement is a manual
one and the distinction is dormant.
_Avoid_: locked (reserve for other domains), fixed (ambiguous with a *fixture*).

**Call** (scheduler-era):
**Starting** a tournament **match** — telling both entrants to play and flipping the
match from *scheduled* (`pending`) to *started* (`in_progress`). Unlike a **placement**,
which is only a **prediction**, a call is a **promise**: the entrants were told, so the
solver holds the started match fixed at its actual occupancy. A match is called only when
its **placement** is *due* **and** its **table** and both its **players** (by **user**,
so it holds across events) are **free** — i.e. no unfinished started match holds them.
A match that runs long therefore **stalls** its successors rather than starting a second
match on the same table or human (which would double-book a physical resource and wedge
the **schedule** infeasible — #1106, ADR 20260718). Calling is driven by a match
**completing** (which frees a table and re-solves), not by a clock poll; the pin tick is
only a backstop for a **Slot** window opening or a tournament's first matches.
_Avoid_: pin (the call *causes* a pin, but a **manual placement** also pins without a
call; the pin is the placement's fixedness, the call is the promise to the players),
notify (the call includes a notification but is the whole state transition, not just it).

**Solve**:
One run of the **scheduler** over a tournament: the CP-SAT job that packs the
event's unplayed, **free** **placements** onto **tables** within each
**reservation**'s **Slot**, holding **pinned** ones fixed, and writes the resulting placements back.
A solve is **requested** (queued), **running**, then reaches a **verdict** —
`succeeded`, `infeasible`, or `failed` — recorded on the tournament's **solve
ledger**; at most one is in flight per tournament at a time (a fresh request
coalesces onto the running one), and a **stale running** solve is reaped by the
next reader or request. Requesting a solve is what "run the scheduler" means; it
is **not** a hypothetical or Monte-Carlo projection of who will win — it computes
*when and where* the real matches play, not their outcomes.
_Avoid_: simulation, run (a solve computes the real schedule, never a
what-if), optimization pass, recalculation.

**Schedule preview** (scheduler-era):
A **solve** run over a **synthetic field** so a director can see whether a
tournament's config would fit *before anyone has registered*. It is the **same**
CP-SAT engine as a real solve — same **verdict**, same **infeasibility reasons** —
but it **persists nothing**: no **entry**, no **fixture** row, no **solve ledger**
entry; the **synthetic field** is drawn in memory and the `SolveResult` lives only
in the job's Redis result with a short TTL. **Owner-gated** and allowed only while
the tournament is **pre-live** (`draft`/`published`), it auto-fills each **event**
to its player cap (**per-event overridable**), draws a **disjoint** synthetic field
per event, and is therefore **optimistic** on duration (it ignores the contention a
multi-**event** player causes — an honest note, not a hidden assumption). Over HTTP
the web client **polls** an ephemeral result; the `preview_schedule` MCP tool
**waits** and returns the result in one call. Like any solve it computes *whether
and when* a field would play, **never** who wins.
_Avoid_: fake schedule (retired vocabulary — it is a *preview* over a *synthetic
field*), simulation, dry run (reserve for other domains), what-if (reserve for the
outcome sense a solve is not).

**Synthetic field** (scheduler-era):
The `Placeholder 1..N` **entrants** a **schedule preview** invents so it has
something to draw and solve, since a preview runs before real registration. They
are never persisted (no `users.id`, no **entry** row — sidestepping the real-user
FK the entry domain requires) and are **disjoint across events** by construction, so
no synthetic player is ever entered in two events.
_Avoid_: fake players, guest entrants (a guest is a real tombstoned **user**;
a synthetic entrant is not a user at all), placeholder match.

**Infeasible** (scheduler-era):
A **solve** outcome: the **scheduler** *proved* the day's matches cannot all be placed
on their tables inside their windows. A **designed outcome, not a failure** — proving a
day does not fit is the point of a pre-live solve — kept distinct from *failed* (the job
itself broke) and from *unknown* (the time cap ran out before any answer). An infeasible
solve changes nothing: the last accepted **placements** stand.
_Avoid_: failed (a broken job, not a proven non-fit), impossible, error.

**Infeasibility reason** (scheduler-era):
Why an **infeasible** solve does not fit, carried as a small closed set of causes rather
than the bare verdict. Each is either a **structural cause** (certain, and it names the
offending **reservation** or **fixture**) or the single residual **timing conflict**
(best-effort). The reason is computed in ids and minutes by the pure solver, then
**resolved to the reservation's display name and wall-clock window at the moment the
solve is applied** — so the ledger row records what the director saw then and stays
legible even if that reservation is later renamed or removed. All structural causes are reported together, so a director fixes them in one pass.
_Avoid_: error message (it is structured data the client renders, not a server sentence),
diagnostic.

**Structural cause** (scheduler-era):
An **infeasibility reason** the scheduler is *certain* of, provable by arithmetic before
CP-SAT runs, and that **names an entity**: a **reservation** with no tables, a
**fixture** whose window is too short to hold even one of its matches, a reservation over
**per-reservation capacity**, or an **over-subscribed** player. Contrast the **timing
conflict**, which is the residual best-effort case.
_Avoid_: hard failure, constraint violation.

**Per-reservation capacity** (scheduler-era):
A **reservation**'s ceiling on match time: its window length times its table count.
Because the **fixtures** of the **groups** it holds can run only on those tables in that
window, aggregate match-time exceeding this ceiling is a *proof* the reservation cannot
fit (sharing tables across reservations only lowers real capacity, never raises it) — one
of the **structural causes**.
_Avoid_: table-time budget (reserve for the whole-day figure the **timing conflict** cites).

**Over-subscribed** (scheduler-era):
A **player** whose matches within one **group** need more time than that group's
**reservation** holds, counting the rest gap owed *between* consecutive matches. A
pigeonhole over a single human — one person plays one match at a time — so it is a
**structural cause**, certain, and the one that names a *person* rather than a
reservation or fixture.
_Avoid_: overbooked, double-booked (that is a **placement conflict** — two matches already
recorded on top of each other, not a day that cannot be arranged).

**Conflict core** (scheduler-era):
The set of **fixtures** that cannot all be placed together — the scheduler's answer to
*which* matches form a **timing conflict**. Reported as a set whose removal would let the day
fit; it is never claimed to be the smallest such set, so the director hears "these could not
be placed", never "you must remove exactly these".
_Avoid_: minimal core, unsat core (both promise a minimality the scheduler does not prove).

**Timing conflict** (scheduler-era):
The residual **infeasibility reason**: CP-SAT proved the day infeasible, yet every
**structural cause** passed — so there *is* enough total table-time and the obstacle is
*arrangement*, not capacity (tables contended across overlapping windows, or matches that
cannot be sequenced). Tells the director not to add tables, and carries a **conflict core**
naming the fixtures. The bare whole-day figure survives only as a floor, for when no core can
be extracted.
_Avoid_: over capacity (the opposite — capacity is sufficient here), unknown (that is the
time-cap verdict, which carries no reason at all).

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
