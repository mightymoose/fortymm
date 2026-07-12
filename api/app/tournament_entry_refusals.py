"""The vocabulary of refusals the tournament-entry endpoint answers with (ADR-0968).

Every refusal from ``POST /v1/tournaments/{id}/events/{id}/entries`` is a **409**
whose body is ``{"detail": {"code": ..., "message": ...}}``. The **code** is the
contract — a client switches on it and owns its own copy; the **message** is prose,
a fallback shown only for a code the client does not recognise. Rewording a message
is therefore safe, which it was not while the client told the refusals apart by
byte-comparing the English sentence (and read every unrecognised 409 as "registration
closed" — a fall-through that stops being fail-safe the moment a third refusal
exists).

The shape follows the precedent in ``sessions.py``, which already answers with
``detail={"code": SESSION_ENDED_CODE, "message": ...}``.

**Adding a refusal is two edits: a member here, and the raise site.** There is no
code→message table to keep in step, because a message is not a pure function of a
code — ``registration_closed`` says something different about a ``draft`` tournament
than about an ``archived`` one, and that per-status sentence is genuinely more
informative than a generic one. The code is the same for all three regardless: what
the client switches on is *why it was refused*, not *how it was worded*.

Scope: the entry endpoint. The withdraw route's 409/403 and the tournament
transition errors are still prose (#968 stays open against them) — a refusal that
does not belong to this endpoint does not belong in this enum.
"""

from enum import StrEnum

from fastapi import HTTPException, status


class EntryRefusal(StrEnum):
    """Why an entry into a tournament event was refused.

    A closed set, not a loose ``str``: a code the client cannot switch on is a code
    the server should not be able to invent (and every member here is a case the
    client is expected to have copy for).

    ``StrEnum``, so a member *is* its wire value — it serialises straight into the
    response body with no mapping step to drift.
    """

    already_entered = "already_entered"
    """The player already holds an *active* entry in this event. Withdrawing frees
    them to enter again, so this is transient, not permanent."""

    registration_closed = "registration_closed"
    """The tournament's registration window is shut — today, because its status is
    ``draft``, ``live`` or ``archived`` (its status *is* its window, ADR-0017)."""

    event_full = "event_full"
    """The event holds ``max_players`` *active* entries already. Transient, like
    ``already_entered``: somebody withdrawing frees the slot (withdrawn entries are
    not entrants, ADR-0016), so the caller may be told something different a minute
    from now — which is exactly why it is a 409 and not a 403.

    Unreachable for an **uncapped** event (``max_players`` is NULL, ADR-0935): with no
    limit there is nothing for the field to reach, so no number of entrants can produce
    this refusal."""

    rating_ineligible = "rating_ineligible"
    """The player's rating on the tournament's ladder fails one of the event's
    eligibility rules (ADR-0783) — the "Under 1500" event, entered by a 1650 player.

    A 409 like the others, and for the same reason: the request is fine (it has no
    body at all), it is the *state of the world* that forbids the entry — and this
    state moves too. A rating is a fact about a player *today*: the same request wins
    or loses depending on how their last rated match went, so "not now" (409) is the
    truth, where 403 would claim a permission they have never lacked.

    Note what does **not** land here: a player with **no rating at all** passes every
    rule and is never refused with this code (ADR-0783 §3). Unrated is not "fails the
    rule"; it is "there is no fact to judge", and the beginners' event is exactly the
    one a brand-new player needs to get into."""


def entry_refused(refusal: EntryRefusal, message: str) -> HTTPException:
    """The 409 for a refused entry: the machine-readable ``code``, and words to fall
    back on.

    A factory rather than a raise, so the call site reads ``raise entry_refused(...)``
    and mypy still sees the ``raise`` — a helper that raised internally would leave the
    caller's flow looking like it could continue past a refusal.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        # A dict detail serialises as ``{"detail": {"code": ..., "message": ...}}``
        # — one level of nesting, which is exactly what ``sessions.py`` already sends
        # and what the client's ``ApiError`` already retains the raw body for.
        detail={"code": refusal.value, "message": message},
    )
