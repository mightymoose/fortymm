# fortymm

Table-tennis match tracking and rating. This glossary captures the project's
ubiquitous language. It is a glossary only — not a spec — and is kept free of
implementation detail.

## Match result negotiation

**Match**:
A contest between two sides, played as a best-of-`N` set of games. A side wins by
taking a majority of the games.

**Scratchpad**:
The live, shared score board for a match before any result is claimed. Either
participant may edit it, one game at a time. It freezes the moment the first
result is proposed.
_Avoid_: draft, working board.

**Decided board**:
A complete, legal set of games — contiguous from game one, every game a legal
table-tennis score, ending the instant one side clinches the majority (no games
recorded after the decider). Every result must describe a decided board.
_Avoid_: finished score, final board.

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
