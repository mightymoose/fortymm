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

from fastapi import HTTPException, status

# The refusal vocabulary itself lives in the transport-neutral domain-error leaf
# (``app.tournament_errors``), so the FastAPI-free ``enter_event`` verb can name the
# refusal it hit on ``EntryRefusedError`` without importing this FastAPI-importing
# module. Re-exported here so the existing HTTP call sites keep importing
# ``EntryRefusal`` from beside the ``entry_refused`` factory unchanged.
from app.tournament_errors import EntryRefusal

__all__ = ["EntryRefusal", "entry_refused"]


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
