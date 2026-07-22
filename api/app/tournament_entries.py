"""The transport-neutral tournament-entry write verb.

The orchestration behind ``POST /v1/tournaments/{id}/events/{event_id}/entries``
(enter a player in a singles event — yourself, or, as the tournament's owner, somebody
else), extracted out of the router so it can run without FastAPI: from the HTTP adapter
(``app.tournaments.enter_event``) and from the MCP ``enter_event`` tool alike, and be
constructed in a plain REPL with a raw session.

This is the highest-nuance tournament verb, and every nuance is preserved exactly:

* **The dual-actor fork (ADR-0784).** ``user_id`` absent (or equal to the actor's own
  id) is **self-registration** — the actor enters themselves, gated on the
  ``tournament.enter`` permission, and the entry records **no adder**
  (``added_by_user_id = NULL``). A **different** ``user_id`` is a **director entry** —
  gated on OWNERSHIP (a non-owner naming somebody else's id is refused), the named user
  must resolve to an enterable player, and the entry records the actor as the adder.
  Naming your OWN id is self-registration whoever you are, because "the player entered
  themselves" has exactly one encoding and ``added_by == user_id`` is not it.

* **Where the** ``tournament.enter`` **gate lives.** In the verb, on the self path only,
  asked through the shared ``app.rbac.user_has_permission`` — the same query the HTTP
  ``require_permission(TOURNAMENT_ENTER)`` dependency runs. It is judged HERE, not at
  each adapter, because the gate is *conditional on the fork* (only self-registration
  needs it) and the fork is computed inside this verb from ``user_id``: keeping the
  check here keeps ONE source of truth for the fork, so neither adapter re-derives who
  is being entered. This mirrors how the HTTP route asked it — inline in the handler
  body, never as a router dependency, because a dependency runs before the body that
  says which arm of the fork this is. It is data-authz (a permission about a *row* the
  caller is writing), which is why it may live in the verb where the read gates
  (``tournament.view``) live at the adapter: those gate *reads* with no body-dependent
  fork, this one cannot.

* **Refusal ordering, judged under the tournament row lock.** The tournament is loaded
  **locked first** (the capacity lock — the row whose status decides this request must
  not change between the checks and the INSERT), then the event. Then, in order: the
  **singles-only 400** (:class:`NonSinglesEntryError`) → the **registration-window 409**
  (``registration_closed``) → the **rating-eligibility 409** (``rating_ineligible``) →
  the **capacity 409** (``event_full``) → the **already-entered 409**
  (``already_entered``, caught as the partial unique index's ``IntegrityError`` at
  commit). The permanent refusals precede the transient ones (a doubles event and a
  wrong-arm director are facts that will not change; a full event or a shut window
  invite a retry), and every one of the four coded refusals is an :class:`EntryRefusal`
  (ADR-0968). A director's entry is judged by the SAME evaluator, the SAME capacity lock
  and the SAME four codes — there is no ``force`` (ADR-0784), so ownership is never an
  eligibility bypass.

Per the tournament-verbs ADR (mirroring ``tournament_lifecycle`` / ``tournament_events``
/ ``tournament_edit``), it signals every refusal with a **domain exception** from
``app.tournament_errors`` — never an ``HTTPException`` — and each adapter maps it back
to the exact response it produced before.
"""

import uuid
from typing import assert_never

from sqlalchemy import exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import tournament_registration
from app.models import (
    EventFormat,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    User,
)
from app.rbac import user_has_permission
from app.schedule_solves import request_solve
from app.schemas.tournament import TournamentEntrantRead
from app.tournament_edit import _load_tournament_for_update
from app.tournament_eligibility import (
    Eligible,
    RatingIneligible,
    evaluate_rating_eligibility,
    event_is_full,
)
from app.tournament_errors import (
    EntryNotFoundError,
    EntryRefusal,
    EntryRefusedError,
    NonSinglesEntryError,
    NotAllowedToEnterError,
    NotAllowedToWithdrawError,
    NotTournamentOwnerError,
    PlayerNotFoundError,
    WithdrawalRegistrationClosedError,
)
from app.tournament_events import _load_event
from app.tournament_queries import active_entry_count, entrant_rating

# The permission the self-registration arm gates on — the same seeded RBAC name the
# HTTP router's ``_require_enter_permission`` enforces
# (``app.tournaments.TOURNAMENT_ENTER``,
# ``scripts/seed_rbac.py``). Held as a literal rather than imported from the router so
# this verb stays FastAPI-free (importing the router would pull in FastAPI and cycle);
# it is asked through the one shared ``user_has_permission``, so the HTTP and MCP
# surfaces gate self-registration on the same grant.
TOURNAMENT_ENTER_PERMISSION = "tournament.enter"


async def _load_entrant(db: AsyncSession, user_id: uuid.UUID) -> User:
    """The player a director named — the one they are entering (ADR-0784), or raise
    :class:`PlayerNotFoundError`.

    Tombstoned (merged-away) users are excluded, exactly as ``/v1/players/search``
    excludes them: a ghost is a user no listing, search or auth query will ever return,
    so entering one would put a player in the draw who cannot sign in, cannot be
    notified and cannot play. A not-found rather than a 422: the id is well-formed, it
    simply names nobody enterable. It is loaded only *after* the ownership gate, so a
    stranger learns nothing about which user ids exist. The FastAPI-free twin of the
    router's ``_get_entrant_or_404``; never an ``HTTPException``.
    """
    user = (
        await db.execute(
            select(User).where(
                User.id == user_id,
                User.merged_into_user_id.is_(None),
            )
        )
    ).scalar_one_or_none()
    if user is None:
        raise PlayerNotFoundError()
    return user


def _enforce_entry_registration_open(tournament: Tournament) -> None:
    """Raise the ``registration_closed`` refusal unless the window is open (ADR-0968).

    Same decision (``registration_open``) and the same words
    (``registration_refusal_detail``) as the withdraw route's enforcer — only the
    envelope differs, because only the entry endpoint's refusals are coded so far. So
    the two routes cannot come to disagree about *whether* registration is open, which
    is the property worth protecting.

    One code for all three closed statuses. The status is *why*, and the client does
    not branch on which one — it branches on "the window is shut", and the per-status
    sentence rides along as the message (a fallback for a client that does not know the
    code, and prose for a human). ``registration_open`` is asked module-qualified so a
    test can stub the single decision point for both the enter and withdraw legs.
    """
    if tournament_registration.registration_open(tournament):
        return
    raise EntryRefusedError(
        EntryRefusal.registration_closed,
        tournament_registration.registration_refusal_detail(tournament.status),
    )


async def _enforce_rating_eligible(
    db: AsyncSession,
    tournament: Tournament,
    event: TournamentEvent,
    user: User,
) -> float | None:
    """Raise the ``rating_ineligible`` refusal unless the player satisfies the event's
    rating rules (ADR-0783) — and hand back the rating it judged them on, ``None`` if
    they hold none.

    Returning it is not a convenience: the entry this verb goes on to create is answered
    as a ``TournamentEntrantRead``, which carries the entrant's rating on this
    tournament's ladder. Re-reading it after the INSERT would be a second query for a
    number already in hand, and — worse — a number that could differ from the one the
    guard actually decided against, so the created entrant could come back rated
    differently from the rating that admitted it.

    The *decision* is not made here — it is made in ``app.tournament_eligibility``,
    which
    the detail read calls too, so the guard that refuses an entry and the page that
    explains why the Enter control is missing cannot come to two different answers. This
    is only the translation: rating in, refusal out. The rating is read on the
    **tournament's** league (its ``league_id``), the ladder the tournament named when it
    was created.

    **A player with no rating there passes every rule and is not refused** (ADR-0783
    §3):
    that is the beginners'-event case. ``match``, not ``if isinstance(...)``: a third
    eligibility outcome added tomorrow is a type error here until it is answered, rather
    than silently falling through and *admitting* the player — a guard must never fail
    in
    the permissive direction. ``user``, not the actor: the rules judge the person being
    ENTERED, so a director adding a 1650 player to the "Under 1500" event is refused
    with
    the same code that player would have got — ownership is not an eligibility bypass.
    """
    rating = await entrant_rating(db, tournament.league_id, user.id)
    decision = evaluate_rating_eligibility(rating=rating, predicates=event.predicates)
    match decision:
        case Eligible():
            return rating
        case RatingIneligible():
            raise EntryRefusedError(EntryRefusal.rating_ineligible, decision.message)
        case _:
            assert_never(decision)


async def _enforce_event_has_room(db: AsyncSession, event: TournamentEvent) -> None:
    """Raise the ``event_full`` refusal once the event holds ``max_players`` entrants.

    **This is only correct when it is called with the tournament's row lock already
    held** (ADR-0783 §4). Capacity is a count on ``tournament_entries`` compared against
    a column on ``tournament_events`` — which no database constraint can express, so
    unlike the duplicate-entry guard (a partial unique index Postgres enforces, caught
    as
    an ``IntegrityError`` after the fact) there is nothing underneath us. The lock is
    the
    entire mechanism: counted outside it, two entrants racing for the final slot each
    read
    ``max_players - 1``, each pass this gate, and each insert — an overfull event from
    two
    requests both answered 201. Inside the lock the count-then-insert is serialised,
    because every entry to every event of a tournament takes that same row lock first.

    Active entries only (ADR-0016): a withdrawn entry is not an entrant and its slot is
    free again. *What* full means (``>=`` not ``==``; an uncapped event is never full)
    is
    ``event_is_full``, shared with the detail read, so the page that reports an event
    full
    and the guard that refuses entry cannot disagree. An **uncapped** event
    (``max_players IS NULL``, ADR-0935) leaves by the first line, before the count:
    there
    is no limit to compare against, so the ``event_full`` refusal is unreachable for it.
    """
    max_players = event.max_players
    if max_players is None:
        return
    entered = await active_entry_count(db, event.id)
    if not event_is_full(entered=entered, max_players=max_players):
        return
    raise EntryRefusedError(
        EntryRefusal.event_full,
        f"This event is full — it has reached its limit of {max_players} players.",
    )


async def enter_event(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
    user_id: uuid.UUID | None,
) -> TournamentEntrantRead:
    """Enter a player in a singles event — ``actor`` themselves, or (as the tournament's
    owner) the player ``user_id`` names — and return the created
    :class:`TournamentEntrantRead`.

    Runs the same orchestration the HTTP handler used to run inline, in the same order
    and under the same lock (see the module docstring for the full nuance):

    * **The fork (ADR-0784).** ``user_id is None`` or ``== actor.id`` →
    self-registration
      (``added_by_user_id = NULL``), gated on ``tournament.enter``; a different
      ``user_id``
      → a director entry (``added_by_user_id = actor.id``), gated on ownership.
    * **The self-registration gate** is asked FIRST, before anything is loaded, on the
      self path only: a caller lacking ``tournament.enter`` raises
      :class:`NotAllowedToEnterError` before the verb learns anything about the
      tournament.
    * The tournament is loaded **locked** (:func:`_load_tournament_for_update`, raising
      :class:`TournamentNotFoundError`) and locked FIRST, then the event
      (:func:`_load_event`, raising :class:`EventNotFoundError`).
    * On the director path, ownership is judged after those 404s (raising
      :class:`NotTournamentOwnerError` before the named player is even looked up, so a
      stranger's refusal never leaks whether the tournament or event exists), then the
      named player is resolved (:func:`_load_entrant`, raising
      :class:`PlayerNotFoundError`).
    * Then, in order: singles-only (:class:`NonSinglesEntryError`, the 400) →
      registration window → rating eligibility → capacity → already-entered — the last
      four
      each an :class:`EntryRefusedError` carrying its :class:`EntryRefusal` code
      (ADR-0968).
      The rating the eligibility guard judged them on is read ONCE and put on the
      created
      entrant. The duplicate refusal is the partial unique index's ``IntegrityError`` at
      commit, so no pre-flight ``SELECT`` opens a race, and nothing is written on any
      earlier refusal (each is judged before the INSERT).

    Commits and refreshes before returning. Never raises ``HTTPException`` — the caller
    adapts each domain exception to its transport.
    """
    # ----- the fork (ADR-0784) ----------------------------------------------
    # One line, decided from ``user_id`` alone, before anything is loaded: WHO is being
    # entered. Everything downstream reads ``entrant`` and does not care how it got
    # there
    # — the evaluator, the capacity lock and the four refusal codes are the same rules
    # for a director as for a player. Naming your OWN id is self-registration: "the
    # player entered themselves" is spelled ``added_by_user_id = NULL``, and writing
    # ``added_by == user_id`` would be a second, contradictory encoding of the same
    # fact.
    entrant_id = actor.id if user_id is None else user_id
    self_registration = entrant_id == actor.id
    if self_registration:
        # Asked here, at the top, exactly where the router handler asked it — the
        # dependency's position, kept. A player without ``tournament.enter`` is refused
        # before the verb learns anything about the tournament. The director's arm is
        # gated by ownership instead, judged *after* the 404s below (you cannot own a
        # tournament that does not exist).
        if not await user_has_permission(db, actor.id, TOURNAMENT_ENTER_PERMISSION):
            raise NotAllowedToEnterError()

    # Load first, then decide — the 404-before-anything-else ordering. The tournament is
    # loaded *locked*, and locked first (the row whose status decides this request must
    # not change between the checks and the INSERT — otherwise an entry passes the
    # ``published`` gate and commits behind the owner's go-live, into a field meant to
    # be
    # sealed). ``_load_tournament_for_update`` locks and raises the 404 but does NOT
    # owner-gate — entering is a player action on somebody else's tournament.
    tournament = await _load_tournament_for_update(db, tournament_id)
    event = await _load_event(db, tournament_id, event_id)

    if self_registration:
        # The caller is the entrant, and nobody added them — that is what NULL means.
        entrant, added_by_user_id = actor, None
    else:
        # The director's arm. Ownership is the gate (403 for anyone else naming somebody
        # else's id), judged after the 404s above so a stranger's refusal never leaks
        # whether the tournament or event exists.
        if tournament.created_by_user_id != actor.id:
            raise NotTournamentOwnerError()
        entrant, added_by_user_id = await _load_entrant(db, entrant_id), actor.id

    if event.format is not EventFormat.singles:
        # Not a policy — a modelling limit (ADR-0016). One row per user cannot express a
        # doubles pairing or a team. ``is not singles`` so a new format is rejected by
        # default. It outranks the status 409: a doubles event is never enterable in any
        # status, so answer with the fact that will not change (and it keeps one clean
        # rule — every "this request cannot work" check precedes every "the state
        # conflicts" check). Refused HERE, before the INSERT, so "no row is written" is
        # a
        # property of the code, not of a transaction that happened to abort.
        raise NonSinglesEntryError(event.format.value)

    # Registration window, then eligibility, then capacity — the transient refusals in
    # the order that answers with the least-changing fact first (a shut window governs
    # every event of the tournament; a rating fails on a retry too; only capacity frees
    # up when somebody withdraws). Eligibility reads the rating (a plain SELECT, no
    # lock)
    # and hands back the number that admitted the entrant — the same number reported
    # beside their name, read once. Capacity is counted UNDER THE LOCK taken above, and
    # nothing between its count and the commit may take a lock of its own.
    _enforce_entry_registration_open(tournament)
    rating = await _enforce_rating_eligible(db, tournament, event, entrant)
    await _enforce_event_has_room(db, event)

    # ``added_by_user_id`` is the fork's one lasting trace: NULL on the self path, the
    # director's id on the other (ADR-0784). A fact about the past, stored now.
    entry = TournamentEntry(
        event_id=event.id,
        user_id=entrant.id,
        added_by_user_id=added_by_user_id,
    )
    db.add(entry)
    try:
        await db.commit()
    except IntegrityError:
        # The partial unique index on (event_id, user_id) WHERE status='entered'
        # rejected
        # this — letting the database decide is the point: a pre-flight SELECT would
        # leave
        # a window in which two concurrent requests both see "not entered" and both
        # insert. ``from None`` drops the DBAPI error so nothing about the schema
        # reaches
        # the response. Because the index is partial, a player whose only prior entry is
        # *withdrawn* does not land here — they enter again cleanly. It is the index,
        # and
        # only the index, that can raise here (which is why ``added_by_user_id`` carries
        # no CHECK constraint — a second constraint would be reported as a false
        # "already entered").
        await db.rollback()
        raise EntryRefusedError(
            EntryRefusal.already_entered,
            "You have already entered this event.",
        ) from None

    return TournamentEntrantRead(
        id=entry.id,
        # The ENTRANT — the caller on the self path, somebody else on the director's.
        # The
        # created row describes who was entered, not who entered them.
        user_id=entrant.id,
        username=entrant.username,
        seed=entry.seed,
        # The rating the eligibility guard above already read on this tournament's
        # ladder
        # — not a fresh one, so the entrant returned is judged by the same number the
        # detail read lists.
        rating=rating,
    )


async def _load_entry(
    db: AsyncSession, event_id: uuid.UUID, entry_id: uuid.UUID
) -> TournamentEntry:
    """The entry ``entry_id`` names **under this event**, or raise
    :class:`EntryNotFoundError`.

    Scoped by event id as well as entry id, the same way :func:`_load_event` is scoped
    by tournament: an entry that exists but hangs off a *different* event is not
    addressable through this URL, so the mismatch is a not-found rather than a
    withdrawal from the event the caller did not name. The FastAPI-free twin of the
    router's ``_get_entry_or_404``; never an ``HTTPException``."""
    entry = (
        await db.execute(
            select(TournamentEntry).where(
                TournamentEntry.id == entry_id,
                TournamentEntry.event_id == event_id,
            )
        )
    ).scalar_one_or_none()
    if entry is None:
        raise EntryNotFoundError()
    return entry


def _enforce_withdrawal_registration_open(tournament: Tournament) -> None:
    """Raise the withdraw route's bare-prose 409 unless the registration window is open.

    The mirror of the enter verb's :func:`_enforce_entry_registration_open`, sharing the
    exact same decision (``registration_open``) and the exact same words
    (``registration_refusal_detail``) — only the envelope differs. ADR-0968 scopes the
    machine-readable ``code`` to the *entry* endpoint, so this one raises
    :class:`WithdrawalRegistrationClosedError`, which the HTTP adapter rebuilds into the
    un-coded 409 the withdraw route has always sent. Keeping both legs on the one shared
    ``registration_open`` decision (asked module-qualified so a test can stub the single
    point for both) is what stops the enter and withdraw routes ever disagreeing about
    *whether* registration is open."""
    if tournament_registration.registration_open(tournament):
        return
    raise WithdrawalRegistrationClosedError(
        tournament_registration.registration_refusal_detail(tournament.status)
    )


async def _trigger_solve_if_seated(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    entry: TournamentEntry,
) -> None:
    """Queue a re-solve when the withdrawn entry was **seated in a cut draw** — the
    scheduling-input trigger (ADR "the schedule is solved; the call is pinned").

    Only a withdrawal that actually changes state owes a solve (the caller runs this
    inside the ``entered`` arm), and only when this entrant is seated in a fixture:
    entries reach the solver only through fixtures, so an entrant with no fixture is
    invisible to it (they entered after the cut, or nothing is cut) and their leaving
    changes no solver input until a re-cut — which triggers on its own. One ``EXISTS``
    decides it, and a seated entrant implies a drawn event by construction, so no
    separate "has a drawn event" gate is needed. Runs in the same transaction, under the
    tournament row lock the verb already holds (the order ``request_solve`` requires); a
    ``None`` return (Redis down) deliberately costs the solve, never the withdrawal."""
    seated = (
        await db.execute(
            select(
                exists(
                    select(TournamentFixture.id).where(
                        or_(
                            TournamentFixture.entry_a_id == entry.id,
                            TournamentFixture.entry_b_id == entry.id,
                        )
                    )
                )
            )
        )
    ).scalar_one()
    if seated:
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)


async def withdraw_from_event(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    entry_id: uuid.UUID,
    actor: User,
) -> None:
    """Withdraw an entry from a singles event — ``actor``'s own, or (as the tournament's
    owner) any entry in it — by **soft-deleting** it: its status flips to ``withdrawn``
    and the row survives.

    Runs the same orchestration the HTTP handler used to run inline, in the same order
    and under the same lock:

    * **Load first, then authorize.** The tournament is loaded **locked**
      (:func:`_load_tournament_for_update`, raising :class:`TournamentNotFoundError`)
      and locked FIRST — the same row lock, in the same order, the
      enter/transition/PATCH routes take, so no pair can deadlock, and so a withdrawal
      cannot pass the ``published`` gate and commit *after* the tournament went live,
      pulling a player out of the very field the draw is cut from. Then the event
      (:func:`_load_event`, raising :class:`EventNotFoundError`) and then the entry
      **under that event** (:func:`_load_entry`, raising :class:`EntryNotFoundError`),
      so a wrong ``(tournament, event, entry)`` triple is a 404, judged before any 403.

    * **The owner-or-self fork (ADR-0784),** read off the ENTRY rather than off a body:
      withdrawing your **own** entry is the mirror of self-registering and is gated the
      same way, on ``tournament.enter`` (asked HERE through the shared
      ``user_has_permission``, exactly where 3a asks the enter verb's self gate — the
      one source of truth for "this self action needs the grant"; a caller lacking it
      raises :class:`NotAllowedToEnterError`). The **owner's** arm deliberately does NOT
      require that permission — managing the field of a tournament you created is a
      property of ownership, not a role grant. Anybody who is neither the entrant nor
      the owner raises :class:`NotAllowedToWithdrawError` — a permanent 403 answered
      before the transient 409 below, so withdrawing someone else's entry from a *live*
      tournament is "not yours", not "not now".

    * **The window gate is on the state CHANGE, not the call** (ADR-0017). Only an
      **active** (``entered``) entry is gated: flipping it to ``withdrawn`` outside the
      registration window raises :class:`WithdrawalRegistrationClosedError`
      (:func:`_enforce_withdrawal_registration_open`), and a withdrawal that actually
      changes state and is seated in a cut draw triggers a re-solve
      (:func:`_trigger_solve_if_seated`). An entry that is **already withdrawn** has
      nothing left to lock, so it skips both — which is what preserves the idempotent
      no-op withdrawal in ``live`` and ``archived`` too.

    Idempotent by construction: withdrawing is an assignment, not a decrement, so
    applied to an already-withdrawn entry it writes the value the row already holds and
    SQLAlchemy emits no UPDATE. The flip only ever *removes* a row from the partial
    unique index's predicate, so — unlike the enter verb — no ``IntegrityError`` is
    reachable here, and the withdrawn player is free to enter the same event again.
    Commits before returning. Never raises ``HTTPException`` — the caller adapts each
    domain exception to its transport.
    """
    # Load-then-authorize, as everywhere else here: the tournament (locked, and first),
    # the event under it, and the entry under that event must all exist before ownership
    # is considered — so a wrong (tournament, event, entry) triple is a 404, and 403
    # means "this entry is real, but it isn't yours to take back".
    tournament = await _load_tournament_for_update(db, tournament_id)
    event = await _load_event(db, tournament_id, event_id)
    entry = await _load_entry(db, event.id, entry_id)

    # The same fork the enter verb makes, read off the ENTRY rather than off a body:
    # this is the caller's own entry, or it is somebody's the owner is removing
    # (ADR-0784). Two authorizations, disjoint, and neither could be a router dependency
    # — which entry it is cannot be known until the row is loaded.
    if entry.user_id == actor.id:
        # Withdrawing your own entry is the mirror of self-registering, gated the same
        # way — ``tournament.enter`` — through the same shared ``user_has_permission``
        # the enter verb's self gate asks, so the two share ONE source of truth. The
        # owner's arm below deliberately does NOT require it.
        if not await user_has_permission(db, actor.id, TOURNAMENT_ENTER_PERMISSION):
            raise NotAllowedToEnterError()
    elif tournament.created_by_user_id != actor.id:
        # Not yours, and not your tournament. A permanent 403, answered before the
        # transient status 409 below, so withdrawing someone else's entry from a live
        # tournament is "not yours", not "not now".
        raise NotAllowedToWithdrawError()

    # The gate is on the state CHANGE (ADR-0017): only an active entry is window-gated,
    # and only an active withdrawal that is seated in a cut draw owes a re-solve. An
    # entry that is already withdrawn has nothing left to lock, so it falls straight
    # through to the idempotent assignment — the 204 in every status ADR-0016 designed.
    if entry.status is TournamentEntryStatus.entered:
        _enforce_withdrawal_registration_open(tournament)
        await _trigger_solve_if_seated(db, tournament_id, entry)

    # Idempotent by construction: an assignment, not a decrement. Applied to an
    # already-withdrawn entry it writes the value the row already holds (no UPDATE
    # emitted), and it only ever removes a row from the partial unique index's
    # predicate, so there is no IntegrityError to catch here.
    entry.status = TournamentEntryStatus.withdrawn
    await db.commit()
