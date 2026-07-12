# 17. Tournament status is a forward-only lifecycle with guarded edges

Date: 2026-07-11

## Status

Accepted

## Context

A tournament carries a `status` of `draft`, `published`, `live`, or `archived`.
The enum has been persisted since epic #595 and is rendered everywhere — the
status pill on the tournaments-list card and the detail hero, and three buttons in
the detail-page header (**Publish**, **Start tournament**, **End tournament**).

None of it is enforced. The three buttons issue a plain
`PATCH /v1/tournaments/{id}` with the whole tournament body and a new `status`,
because `TournamentUpdate.status` is an ordinary optional field. `TournamentCreate`
accepts a `status` too, defaulting to `draft` but taking any value. So an owner —
or anything that can talk to the API as one — can walk the lifecycle backwards
(`live → draft`), skip it entirely (`draft → archived`), or create a tournament
that is born `live`. The status is not merely inert: it is *forgeable*, and every
downstream slice of epic #780 that wants to key off it (draw generation locking a
field of entrants, standings assuming play has begun) would be keying off a value
no invariant protects.

Registration (#781, ADR-0016) landed on top of this. A player may enter any singles
event of any tournament in any status, including a `draft` nobody has published and
an `archived` one that finished last year.

## Decision

### The lifecycle is a forward-only path, and its edges are the only way to move

Exactly three transitions are legal:

```
draft ──publish──▶ published ──go live──▶ live ──archive──▶ archived
```

Everything else is a `409`: un-publishing (`published → draft`), abandoning a draft
(`draft → archived`), skipping a stage (`draft → live`), anything out of `archived`
(it is terminal), and re-asserting the status a tournament already holds
(`published → published`).

Two of those deserve their reasons stated, because a reader will ask.

**Un-publishing is not a transition, because publishing is what opens
registration.** Entries exist against a published tournament; walking back to
`draft` would strand them in a state whose whole meaning is "registration has not
opened". A tournament that should not have been published is a tournament to
archive or delete, not to rewind.

**Re-asserting the current status is a conflict, not a no-op.** The temptation is
to make it idempotent — `PUT`-like, harmless. But the only caller that ever sends
`published → published` is a stale one: a second tab, a double-submitted form, a
client working from a view of the world that has already moved on. Answering `200`
tells it that it did something, when what actually happened is that somebody else
did. `409` is the truth.

Legality is a property of the *edge*, not of the target. A single table of
`(from, to)` pairs is the whole rule, and it lives in one place.

### A transition is a resource you create, not a verb you call

`POST /v1/tournaments/{id}/transitions`, body `{"to": "published"}`, returning the
updated tournament.

The alternative — `/publish`, `/go-live`, `/archive` as three routes — reads more
plainly in the OpenAPI document, and was rejected anyway. Three routes are three
guards, and three guards drift. One route means one edge table, one `409` path, and
one place for slice B to hang a per-target precondition off (go-live will
eventually require a generated draw, #785); with three routes that precondition has
a route of its own to be forgotten in.

It also matches how this codebase already models state change. The match model
(#721) does not expose `POST /matches/{id}/accept`; it exposes
`POST /matches/{id}/results` and `POST /matches/{id}/results/{id}/acceptance` — the
state change *is* a sub-resource that comes into existence. A transition is the
same shape.

### `status` leaves the write schemas entirely

`TournamentUpdate.status` and `TournamentCreate.status` are **removed**. A
tournament is born `draft` (the column default) and moves only across a guarded
edge.

This is the load-bearing half of the decision, and without it the rest is theatre:
a guard on `POST /transitions` that leaves a `status` field on `PATCH` has not
guarded anything, it has only added a second door to a room whose first door is
still open. Sending `status` to either write route is now a `422` (both schemas are
`extra="forbid"`).

### Entering and withdrawing require `published` — and withdrawal stays idempotent

A tournament's status *is* the state of its registration window:

| status      | registration                                            |
| ----------- | ------------------------------------------------------- |
| `draft`     | not open yet — the tournament is not announced           |
| `published` | **open** — enter and withdraw freely                     |
| `live`      | locked — the field is fixed; the draw is cut from it     |
| `archived`  | locked — it is over                                      |

Both `POST …/entries` and `DELETE …/entries/{id}` are gated, not just entry.
Withdrawing after go-live would pull a player out from under a draw generated from
the field they were part of, which is precisely the "locks entries" that going live
is supposed to mean. A player who genuinely must withdraw from a live tournament is
a director's problem (#784), on a director's endpoint.

The refusal is a **`409`, not a `403`**. The caller is permitted — they hold
`tournament.enter`, and it is their own entry. The *tournament* is in the wrong
state. `403` would say "not you"; the truth is "not now".

One exception, and it is deliberate: **withdrawing an already-withdrawn entry
remains a `204` in every status.** ADR-0016 made that idempotency a designed
invariant — "this is `DELETE`, and asking for a state the resource is already in is
a success" — and a status gate applied bluntly would quietly convert it into a
`409` for a request that changes nothing. The gate is on the *state change*, not on
the call: an entry that is already withdrawn has nothing to lock.

### Transitions are owner-only, with no permission of their own

They go through the existing `_require_owner`, like every other tournament
mutation. There is deliberately no `tournament.publish` permission — as the route
module already says, managing a tournament you created is a property of ownership,
not a role grant.

The existing 404 → 403 → 409 ordering holds: a tournament that does not exist is a
`404` before ownership is considered; a tournament that is not yours is a `403`
before its status is; and only then is the edge itself judged.

## Consequences

The three header buttons stop being a lie. Each one now names an edge that exists,
and the API refuses the ones it does not offer — so a stale tab that clicks
**Publish** on a tournament somebody already started gets a `409` instead of
silently dragging it backwards.

Registration acquires a window. The event card's Enter control is no longer offered
against a draft nobody can see the point of entering, or an archive that ended.

`status` becoming read-only on the write schemas ripples through the generated
clients: `web-client/src/api/schema.d.ts` and `ios/Fortymm/Generated/Types.swift`
both lose the field from the create/update bodies, and any caller still sending it
now gets a `422` rather than being quietly obeyed.

Two related holes are **left open on purpose**, because they are not this slice:

- **Editing is not locked when a tournament goes live.** `PATCH /tournaments/{id}`
  and the event CRUD routes still work in every status. Locking entries but not the
  events those entries are against is admittedly half a lock; closing it is a
  follow-up, not a smuggled-in scope increase.
- **Drafts are visible to everyone with `tournament.view`.** A tournament nobody
  has published still appears in the list for any signed-in user, which sits oddly
  beside "publishing is what announces it". That is a visibility bug with its own
  ticket, and fixing it here would have hidden a real change inside a lifecycle PR.

Slice B (#785, #786) gets what it needs: a `live` tournament whose field of
entrants cannot change under it, reached through a single dispatch point where the
"go-live requires a generated draw" precondition will slot in.
