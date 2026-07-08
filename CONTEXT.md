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

## Dashboard

**First-match**:
The dashboard state for a player with no completed matches and nothing in
play — no match currently needs scoring, reviewing, or a result accepted. A
player with an unfinished match is not first-match, even at zero completed
matches: that match's own dashboard treatment takes priority so it is never
hidden behind a "log your first match" prompt.
_Avoid_: zero state, empty dashboard, new user.
