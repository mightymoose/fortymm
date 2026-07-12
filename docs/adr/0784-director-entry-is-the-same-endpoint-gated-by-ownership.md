# 784. Director entry is the same endpoint, gated by ownership

Date: 2026-07-12

## Status

Accepted

## Context

A tournament director needs to put players into an event themselves — a phone entry,
someone without an account yet, or simply fixing a mistake before publishing.
Today `POST .../entries` hard-codes the caller:

```python
entry = TournamentEntry(event_id=event.id, user_id=current_user.id)
```

It takes no request body at all, and a code comment in `tournaments.py` asserts that
a director entry would be "a different endpoint". Withdrawal is likewise self-only,
guarded by `"You can only withdraw your own entry."`

## Decision

**One endpoint. The presence of a `user_id` in the body selects the actor, and the
actor selects the guard.**

* **No `user_id`** → self-registration. Guarded by the `tournament.enter` permission.
  Byte-for-byte today's behaviour.
* **`user_id` present** → director entry. Guarded by `_require_owner`.

`DELETE` unifies the same way: the current self-only guard relaxes to *"your own
entry, **or any entry if you own the tournament**."*

The two authorizations are cleanly disjoint — a stranger self-registering is not the
owner; an owner adding someone else is not self-registering — so this is a single
fork at the top of the handler, not a tangle.

The reason to unify rather than twin is ADR-0968. Both callers must produce the same
refusal codes, run the same eligibility evaluator, and take the same capacity lock.
Two routes means the *next* refusal has to be added twice, and the two call sites of
the evaluator must be kept from drifting — which is exactly the class of bug we just
spent ADR-0968 deleting. Unifying makes there be one place refusals live.

### `added_by_user_id`

`TournamentEntry` gains **`added_by_user_id`** — nullable FK to `users`; `NULL`
means the player entered themselves. It records how an entry came to exist, which is
a fact that cannot be reconstructed later if we decline to store it now.

As a new FK to `users.id`, it **must** be handled by the account-merge service
(`api/CLAUDE.md`), or a merged director's entries break. That is part of this change,
with a test, not a follow-up.

### The director gets no override — yet

The ticket floated a `force` flag letting the owner bypass eligibility and capacity.
**We are not shipping it**, and the consequence is worth stating rather than
discovering:

**Without `force`, #784 does not solve walk-ins.** Registration closes at go-live, so
once a tournament is `live` the director can neither add a walk-in nor remove a
no-show — which are the on-the-day cases the ticket's own motivation names. What
ships here is "the director may add and remove players **during registration**":
phone entries, accounts that don't exist yet, mistakes caught before publish.

Withdrawal stays **symmetric** with entry — the owner obeys the same registration
window a player does. The asymmetric alternative (an owner may withdraw at any time,
but only add during registration) is the more useful product, and we still rejected
it: it is an override leaking back in through the withdraw door, with different
rules and no flag to name it. The override story belongs in one coherent ticket, and
that ticket now carries both the walk-in and the no-show case.

## Consequences

* The director's entries run through **the same evaluator, the same capacity lock and
  the same four refusal codes** as a player's. A director's typo is caught by the
  same rules that catch a stranger's — which, absent `force`, is the entire safety
  model.
* An entry knows who created it. The entrants list can say "added by the director".
* A director cannot fix anything once the tournament is live. This is a real gap, it
  is deliberate, and it is tracked — not an oversight to be discovered on a Saturday
  morning at a tournament desk.
* `GET /v1/players/search` is untouched. It excludes the caller, which would stop a
  director finding *themselves* in the Add-player typeahead — but a director entering
  themselves simply uses the ordinary Enter control, which already exists and already
  works. We are not adding a flag to solve a problem we do not have.
