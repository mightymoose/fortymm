# 968. Entry refusals are machine-readable codes, not prose

Date: 2026-07-12

## Status

Accepted

Partially resolves #968 (raw API detail strings reaching the UI), for the tournament
entry endpoint. The rest of `tournaments.py` — the transition 409s, the 404s, the
403s — remains prose, and #968 stays open against them.

## Context

`POST /v1/tournaments/{id}/events/{id}/entries` refuses in two ways today, and both
are a bare `HTTPException(status_code=409, detail="<an English sentence>")`, which
FastAPI serialises to `{"detail": "You have already entered this event."}` — no
code, no structure, nothing a program can switch on.

So the web client switches on the sentence:

```ts
const ALREADY_ENTERED_DETAIL = 'You have already entered this event.'

function entryConflict(error: unknown): EntryConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  return error.detail === ALREADY_ENTERED_DETAIL
    ? 'already-entered'
    : 'registration-closed'
}
```

A byte-for-byte comparison against English prose, with **every unrecognised 409
falling through to "registration closed"**. The function's own docstring admits this
is a workaround and asks for a code.

The fall-through was fail-safe with two refusals. It stops being fail-safe the
moment there is a third. #783 adds *two* — an event at `max_players`, and a player
whose rating fails a rule — and both would land in the `else` branch, so a player
entering a **full** event on a **published** tournament would be told **"Entries are
closed for this event"**: a headline that contradicts the very sentence printed
underneath it. #784 then adds more refusals still.

Worse, the sentence is load-bearing in a way nothing declares. Reword
`"You have already entered this event."` for clarity — drop the period, say "you're"
— and the client silently reclassifies an already-entered player as a closed
registration window. Copy is not an API contract, but here it was one.

`DEFINITION_OF_COMPLETE.md` already forbids the outcome: *"Raw API detail strings
never reach the UI."*

## Decision

**Every refusal from the entry endpoint is a `409` carrying a machine-readable
`code`. The client switches on the code and owns its own copy. The server's sentence
is a fallback, never a contract.**

```python
detail={"code": "event_full", "message": "This event is full."}
```

There is precedent: `sessions.py` already returns
`detail={"code": SESSION_ENDED_CODE, "message": …}`, and the client's `ApiError`
already retains the raw `body`, so a structured detail costs nothing to read.

### The codes

| `code` | meaning |
| --- | --- |
| `already_entered` | the player already holds an active entry |
| `registration_closed` | the tournament is `draft`, `live` or `archived` |
| `event_full` | the event has reached `max_players` |
| `rating_ineligible` | the player's rating fails one of the event's rules |

The two **existing** refusals are converted along with the new ones. A hybrid — old
refusals as prose, new ones as codes — would leave `entryConflict` still matching
strings, which is the bug. Converting all four is what lets the string comparison be
deleted outright.

### One status, not several

Every refusal is a **409**, including rating-ineligibility. Issue #783's text asked
for a `422` there, and we are deliberately not doing that:

* **There is nothing unprocessable.** Self-registration `POST .../entries` carries no
  request body; the handler reads `current_user.id`. A 422 claims the *input* was
  malformed. The input is fine — the *state of the world* forbids the entry, which
  is what 409 means, and what the sibling refusals already use.
* **422 already has a body shape, and it is not ours.** FastAPI returns 422 for
  Pydantic validation failures as `detail: [{loc, msg, type}, …]` — an array — and
  the client's `flattenDetail` special-cases it. A hand-rolled 422 carrying
  `{code, message}` would give one status **two incompatible body shapes**, forcing
  the client to sniff which it received. That is a new discrimination problem,
  introduced by the very change whose purpose is to delete one.

The `code` carries the discrimination now, so the status does not have to. That is
the whole payoff: the status says "state conflict", the code says which, and the
next refusal is a new code rather than a new status *and* a new shape.

## Consequences

* `entryConflict` stops reading English and switches on `code`. The exported
  `ALREADY_ENTERED_DETAIL` constant is deleted.
* Refusal **copy becomes the client's**, per `DEFINITION_OF_COMPLETE.md`. The API's
  `message` survives as a fallback for a code the client does not recognise — which
  is the honest degrade: report the server's own words rather than invent a headline.
* Rewording a server-side message is now safe. It was not before.
* Adding a refusal in #784 is a new code and a new `case`, in one place each.
* This is a **partial** fix. `tournaments.py`'s other errors are still prose, and the
  broader `notifyError` path still passes `error.message` into a toast description.
  #968 stays open. We are not fixing it here; we are declining to make it worse in
  the one endpoint we are already opening.
