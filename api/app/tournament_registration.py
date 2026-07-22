"""The tournament registration-window decision and its refusal copy — in one
FastAPI-free place both the entry verb and the withdraw route share.

A tournament's status *is* its registration window (ADR-0017): the window is open in
``published`` and shut in the other three. That one rule, and the words for a refusal,
are the part the two routes that judge it — entering an event
(``app.tournament_entries.enter_event``) and withdrawing an active entry
(``app.tournaments.withdraw_from_event``) — must NOT fork on, or the page would offer
an Enter button the API refuses (or hide one it would have honoured).

Extracted out of the router so the transport-neutral entry verb (which must not import
the FastAPI router, and would cycle if it did) can reach the *same* decision the
withdraw enforcer reaches. Both call it **module-qualified**
(``tournament_registration.registration_open(...)``), so a test that stubs the
predicate to explore a future "closed for some other reason" window
(``test_a_closed_window_refuses_even_when_the_status_is_published``) overrides one
attribute here and both legs see it — the single overridable decision point survives
the split across two modules.
"""

from typing import Literal, assert_never

from app.models import Tournament, TournamentStatus

# The exhaustive ``match`` in ``_registration_closed_detail`` narrows against this
# ``Literal``, so a fourth closed status added to the enum is a type error until
# somebody writes the sentence a player should read — the "map an enum in one place
# with an exhaustive match, no catch-all" rule (``api/CLAUDE.md``). A dict keyed by
# status would answer a new member with a runtime ``KeyError`` instead.
ClosedRegistrationStatus = Literal[
    TournamentStatus.draft,
    TournamentStatus.live,
    TournamentStatus.archived,
]


def _registration_closed_detail(status: ClosedRegistrationStatus) -> str:
    """Why registration is refused, in words a player can read.

    The status is not merely echoed back: "not yet" and "too late" are different
    things to be told, and a client that only knew "you cannot enter" could not
    say which.

    Both entering and withdrawing an active entry are refused for the *same*
    reason — the registration window is shut — so both say it with this one
    function rather than drifting into two half-maintained copies of the same
    three sentences. Each sentence leads with the fact about the *tournament*
    ("has not been published yet", "is already under way", "has ended"), which is
    what a player on either side of the window needs to be told.
    """
    match status:
        case TournamentStatus.draft:
            return (
                "This tournament has not been published yet, "
                "so its events are not open for entry."
            )
        case TournamentStatus.live:
            return "This tournament is already under way, so its entries are locked."
        case TournamentStatus.archived:
            return "This tournament has ended, so its events can no longer be entered."
        case _:
            assert_never(status)


def registration_refusal_detail(status: TournamentStatus) -> str:
    """The words for a refusal, for *any* status a refusal can arrive in.

    This is the total function ``_registration_closed_detail`` deliberately is not.
    The narrow one only speaks about the statuses that are closed *because of the
    status* — and mypy's narrowing past the ``published`` test below is what keeps
    its ``Literal`` exhaustive, so a fourth closed status added to the enum is a
    type error until somebody writes the sentence a player should read. Losing that
    would be the real cost of making the copy helper total.

    So the totality is bought here instead, and only here: ``published`` falls
    through to a generic sentence. That branch is unreachable today — ``published``
    *is* the open status — but it stops being unreachable the moment
    ``registration_open`` grows a second condition (an entry deadline, a capacity
    cap, #784), and a ``published``-but-closed tournament reaches the refusal path
    for a reason that has nothing to do with its status. The generic sentence is
    the honest one to say then: the status is not why the window is shut, so naming
    it would mislead. When such a rule lands, its author gives it its own sentence
    — but a guard must never depend on that having happened yet. Refusing vaguely
    is a bug report; permitting the write would be a corrupted field.
    """
    if status is not TournamentStatus.published:
        return _registration_closed_detail(status)
    return "Registration for this tournament is closed."


def registration_open(t: Tournament) -> bool:
    """Whether a tournament's registration window is open right now (ignoring who
    is asking, and what they want to do with it).

    This is the whole rule, and it is one line: a tournament's status IS its
    registration window (ADR-0017), so the window is open in ``published`` and shut
    in the other three.

    Single source of truth shared by every guard that has to know — entering
    (``app.tournament_entries.enter_event``), withdrawing an active entry, and
    whatever comes next (a ``can_enter`` flag on the BFF read) — so a third caller
    cannot quietly grow a fourth opinion about when registration is open. The routes
    ask their own enforcer; the *decision* lives here, exactly once.
    """
    return t.status is TournamentStatus.published
