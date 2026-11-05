# How matches work

This document explains how FortyMM records a match: what each piece is,
how a score turns into a result, and why the rules are what they are. It
covers the server's tables and the rules the services apply to them. The
signed result format itself is specified in
`api/signed-results/README.md`. The tables are in
`api/src/fortymm_api/models.py`, and the rules in
`api/src/fortymm_api/services/matches.py` and `match_results.py`.

The decisions behind this design are in the epic, #181, and in #187 and
#188.

## The idea in one paragraph

Anyone can keep score on a match, but only the players settle it. Scores
are kept on a scratchpad, the board, which anyone can edit and which never
counts. When a player is happy with the scores, their device signs them.
The signed scores are a result. A result counts once the right players
have approved it with their signatures. A player who disagrees signs
different scores that replace the result, and the back and forth goes on
until one result has every approval it needs. Every request that sends a
match something is logged, so the history shows who sent what. Sending
boards and results needs the `matches.score` permission, so an admin turns
scoring on for whom they choose.

## The pieces

| Piece | What it is | Table |
| --- | --- | --- |
| Match | Two sides playing under fixed settings. | `matches` |
| Settings | The match's rules: team size, best of, rated. Fixed when the match is made. | `match_settings` |
| Side | One of the match's two sides, 0 or 1. | `match_sides` |
| Side player | A player on a side. | `match_side_players` |
| Board | The scratchpad's current scores. It's provisional and settles nothing. | The newest accepted `board` row of `match_submissions` |
| Result | One set of scores that someone signed, or that an administrator imposed. | `match_results` |
| Approval | One signature on a result, for one side. | `match_approvals` |
| Submission | One request that sent the match a board, a result or an override. | `match_submissions` |

### Match and settings

A match is made with its settings and both sides in one go. Nothing about
them changes afterwards. The players, the format and whether the match is
rated are fixed. A trigger refuses any change, and a deferred trigger
checks at commit that the match has two sides of `team_size` players each.

The match's id is made on the device (a UUIDv7), so a retry names the
match the first try made. `POST /v1/matches` creates it, with the id in
its body. It answers with only the id, `{"data": {"id": "<uuid>"}}`, 201
for a new match. A retry with the same details finds the match and answers
200, and one with other details gets a 409. The web client's scoring page
reads the match from its URL fragment alone, which holds the id, the
format, `rated` and the players from the first draft on. So it opens with
no signal, and a fragment that is empty, can't be read or names another
match shows the not-found page.

Only `POST /v1/matches` makes a match. A board or a result for a match
the server doesn't know gets a 404, and nothing is written. Both carry
the match id, the format, `rated` and the players, so the server can tell
one that doesn't fit the match it names.

A match is best of 1, 3, 5 or 7, with games to 11, won by 2. Only singles
for now (`team_size` 1). The tables already have sides of players, so
doubles needs no new tables, only a v2 of the result format and a rule for
who approves for a doubles side.

### Sides

Side 0 and side 1 are the indexes the signed result format uses. A
payload's `players` list is in side order, each game's points are in side
order, and each signature says which side it approves for. A result whose
players are on the wrong sides doesn't belong to the match.

### The board

The board is what the scoring screen shows. It lives in the page's URL,
and each save pushes a copy to the server in the background so that
spectators can follow. The server keeps every push in `match_submissions`.
The current board is the newest one it accepted, and the last write wins.
The server never checks a board's signatures and never treats it as a
result.

### Results

A result is one distinct payload: the scores, the ending (completed or
retired), the format and an optional `replaces`. The bytes are stored
once, however many devices send them. A result is identified by the
SHA-256 of its payload. That's how clients refer to a result, because a
device that's offline can't know the server's id for it. The server finds
a result by hash with `sha256(payload) = :hash`, which a unique index
covers. There is no hash column, since the hash is always computed from
the payload.

The payload is the only copy of the scores. The server decodes it when it
needs the games.

### Approvals

An approval is a signature over a result's payload, for one side. A
signature covers the payload, not the envelope that delivered it, so it
counts once however many envelopes carry it. Each approval records:

- the signing key, and the account it belonged to when it was accepted
- the player it approves for, and the authority: `self` for the account's
  own player, `representative` for a player it manages
- the submission that first brought it

### Submissions

A submission is one request: a board push, a result upload or an
administrator's override. It records:

- the bytes sent
- the account of the session
- the network the request came from
- the outcome: `accepted`, or the reason it was refused
- the result it was about, if it got that far

Every request for a match that exists is logged, including retries and
refusals. That's the evidence for spotting abuse, such as a stream of bad
signatures, or a result sent from a network neither player uses. A
request for a match that never exists leaves no row, because it would be
noise with nothing to attach to.

## One match, start to finish

Ann and Bea play a rated best of 5.

1. **Ann's phone creates the match.** The match, its settings, two sides
   and one player on each are written in one transaction, by
   `POST /v1/matches`.
2. **Ann saves games.** Each save sends the board. Each push is a `board`
   submission, and the newest accepted one is what spectators see.
3. **Ann submits 3–1.** Her phone signs the scores, then uploads the
   envelope. The server logs the submission and stores the payload as
   result R1. It also stores Ann's approval for side 0. A rated result
   needs both sides, so R1 waits.
4. **The response is lost and Ann's phone sends it again.** The server logs
   a second submission. R1 and Ann's approval already exist, so nothing
   else changes.
5. **Ann's phone signs badly once.** That submission is logged as
   `bad_signature`, and nothing else is written.
6. **Bea opens the link and disagrees.** She thinks game 3 went the other
   way. She edits the scores to 3–2 and signs. Her phone fills in
   `replaces` with R1's hash. The server stores R2, which replaces R1, with
   Bea's approval for side 1. R1 stays on record, but it can never be
   approved now.
7. **Ann agrees with Bea's scores and approves R2.** R2 now has both sides.
   The server locks the match, sets R2's `accepted_at`, and points
   `matches.current_result_id` at R2. The match is final.

```
R1 (3–1, Ann)  ←replaces─  R2 (3–2, Bea, then Ann)   ← current
```

## The rules

### The chain

A match's results form one chain. Each result names the one it replaces,
or nothing if it's the first.

- **One first result, and one successor each.** The unique index
  `one_successor` on `(match_id, replaces_id)`, with `NULLS NOT DISTINCT`,
  enforces it. If two devices counter the same result, the second gets a
  409, and that's a database rule, not just a service check.
- **Every new result replaces the head.** The head is the result nothing
  replaces. That holds for a counter, a correction and an override alike.
  Since a pending counter already takes the current result's successor
  slot, a correction or override made while it waits replaces the
  counter, and cuts it off.
- **A result replaces only a row that already exists.** A trigger
  refuses anything else, even within one multi-row insert, so the chain
  can never loop.
- **Only the head can be approved.** Approving an older result would
  change nothing. The service checks this, not the database.
- **Current means the newest accepted result**, never the newest result.
  The newest may be half-signed. `matches.current_result_id` names the
  current one. A match starts with none. A trigger lets the pointer move
  only to an accepted head of the same match, and never back to NULL. So
  a final match stays final, and the pointer only moves forward.
- **A result changes once.** Its `accepted_at` is set when it becomes
  current, and nothing else about it ever changes. A trigger refuses
  everything else, and deletes.

### When a result counts

| Result | Approvals it needs |
| --- | --- |
| Rated | Both sides. |
| Unrated | One side. Until the other side approves too, it shows as "reported by" that player. |
| A correction of an accepted result | Both sides, rated or not. |

The last row stops a ping-pong. Without it, two players in an unrated
match could each overwrite the other forever with one signature.

The service checks the rule when the last needed approval arrives. It
locks the match first, so two approvals arriving at once can't both move
the pointer.

### Who may approve

An account approves for its own `self` player, and for a player it
manages (`representative`). A player with an open "Is this you?" question
doesn't count as managed. Creating a record for an opponent gives no right
to approve for them. The approval keeps the account, player and authority
as they were when it was accepted.

### Overrides

An administrator with `matches.override` can impose a result, with a
reason:

1. The server encodes a payload for the given scores, with `replaces` set
   to the head's hash. That's usually the current result, or a counter
   still waiting on it.
2. It logs the request as an `override` submission, with the
   administrator's account.
3. It stores the result with `override_reason` and no approvals, and
   accepts it at once.

The override has a payload hash like any result, so players can still
correct it the normal way. A device still holding a result the override
replaced or cut off gets a 409.

### Merges and adoption

- **Player merge.** Rows keep the player ids they were written with. Reads
  and comparisons resolve `merged_into` first, so a result signed before a
  merge still matches its match. Two players who played each other, in a
  match with a result, never merge, so the two sides stay two people. A
  merge of two players who share only a match with no result still can, and
  a result for that match is then refused with `same_player`.
- **Guest adoption.** A match, a submission and an approval keep naming the
  guest account that acted. The guest's row stays, with `adopted_into` set,
  so the history can still be followed. These columns are `KEPT_AS_RECORD`
  in `OWNERSHIP_RULES`.

## Working offline

- A device makes match ids itself, so play starts with no signal.
- Both players must have opened FortyMM online at least once on their
  device. Player ids are made by the server, and each device needs a
  registered signing key.
- A half-signed result travels between phones as a link or a QR code.
  Either device uploads it once it's back online.
- The server judges every upload when it arrives. A time the device
  claims bypasses nothing.

## How the services keep the rules

- **Refusals and the log.** A refusal that raised inside the request's
  transaction would roll back its own submission row. So a service
  returns a refusal as a value, `Refused`, once the match exists, and the
  route answers it without raising. The row commits with the request.
- **The match's lock.** Every write to a match locks its row first, so
  two counters take turns. The second counter finds a new head and gets
  a 409, logged. `one_successor` stays as the database's backstop.
- **Who sent a result, and when.** That's its first submission
  (`min(id)` where `result_id` is the result). The result row doesn't
  store it.
- **Find a result by hash.** The services write `sha256(payload) =
  :hash` exactly, so the index applies.
- **A retry.** A signature already recorded with the same bytes needs no
  key, so an exact retry converges whatever happened to its keys.

## Not built yet

- Reading a match. No route reads one yet. The reads come with the match
  pages that need them, so spectators can't follow a board yet.
- The clients sending boards and results to these routes, rather than to
  the demo server (#195).
- Player short codes for picking an opponent (#187).
- Counting a match as a player's activity for "Is this you?" (#124), and
  a player's match count.
- Doubles: a v2 payload and the doubles approval rule.
- Walkovers, voids, pre-play states such as scheduled and called, and
  director rulings, which come with tournaments (#189).
- Ratings, which will read the current results of rated matches.
- Rate limits on creating and scoring.
