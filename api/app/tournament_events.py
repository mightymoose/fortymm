"""The transport-neutral tournament-event write verbs.

The orchestration behind ``POST /v1/tournaments/{id}/events`` (create an event),
``PATCH /v1/tournaments/{id}/events/{event_id}`` (update one), and
``DELETE /v1/tournaments/{id}/events/{event_id}`` (delete one), extracted out of the
router so each can run without FastAPI: from the HTTP adapters
(``app.tournaments.create_event`` / ``update_event`` / ``delete_event``) and from the
MCP ``create_event`` / ``update_event`` / ``delete_event`` tools alike, and be
constructed in a plain REPL with a raw session.

Per the tournament-verbs ADR (mirroring ``tournament_lifecycle`` /
``tournament_edit``), each verb signals every refusal with a **domain exception**
from ``app.tournament_errors`` — never an ``HTTPException`` — and each adapter maps
it back to the exact response it produced before. All three verbs load the parent
tournament through the shared owner-loader
(:func:`app.tournament_edit._load_owned_tournament_for_update`), which locks the
tournament row and judges the refusals **404 → 403** (the tournament's absence
before its ownership, so a caller who is not the owner never learns whether an
absent id existed), exactly as the slice-1 lifecycle verbs do.
"""

import uuid
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.draws import group_label
from app.models import (
    DrawType,
    ScheduleSolveTrigger,
    TournamentEvent,
    TournamentEventReservation,
    TournamentFixture,
    User,
)
from app.schedule_preview import preview_field_size
from app.schedule_solves import request_solve
from app.schemas.tournament import (
    DrawSettingsWriteArm,
    MatchSettings,
    ReservationWindow,
    RoundRobinDrawSettingsWrite,
    RrThenKoDrawSettingsWrite,
    SingleElimDrawSettingsWrite,
    Slot,
    SwissDrawSettingsWrite,
    TournamentEventCreate,
    TournamentEventUpdate,
    enforce_event_reservation_cap,
    enforce_reservation_containment,
    named_list,
    reservation_windows,
)
from app.tournament_draw_settings import (
    draw_settings_of,
    draw_settings_row,
    store_draw_settings,
)
from app.tournament_draws import event_groups, event_has_draw, event_reservations
from app.tournament_edit import _load_owned_tournament_for_update
from app.tournament_errors import (
    DrawTypeFrozenError,
    EventNotFoundError,
    GroupSetFrozenError,
)
from app.tournament_event_stages import mint_stages, remint_stages_in_place
from app.tournament_queries import stage_ids_for_events
from app.tournament_reservations import (
    apply_event_reservations,
    materialise_event_groups,
    materialise_groups,
    ordered_reservations,
    stored_reservations,
)


async def _load_event(
    db: AsyncSession, tournament_id: uuid.UUID, event_id: uuid.UUID
) -> TournamentEvent:
    """Load the event ``event_id`` **under the named tournament**, or raise
    :class:`EventNotFoundError`.

    The FastAPI-free twin of the router's ``_get_event_or_404``: the lookup is scoped
    by BOTH ids so a well-formed pair that names no addressable event — a right event
    id under the wrong tournament id included — is a miss, not a cross-tournament
    edit. Raises the domain exception the adapter maps to the existing 404
    ``"Event not found."``; never an ``HTTPException``.
    """
    event = (
        await db.execute(
            select(TournamentEvent).where(
                TournamentEvent.id == event_id,
                TournamentEvent.tournament_id == tournament_id,
            )
        )
    ).scalar_one_or_none()
    if event is None:
        raise EventNotFoundError()
    return event


async def create_event(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
    payload: TournamentEventCreate,
) -> tuple[TournamentEvent, uuid.UUID]:
    """Create an event under the tournament ``actor`` owns, and return the refreshed
    :class:`TournamentEvent` together with the tournament's ``league_id``.

    Loads the parent through the shared :func:`_load_owned_tournament_for_update` (the
    tournament row lock, then the owner gate) so the refusals are judged **404 → 403**,
    the order the create route kept:

    * **404** — an absent tournament id raises :class:`TournamentNotFoundError`.
    * **403** — a caller who is not the tournament's creator raises
      :class:`NotTournamentOwnerError`. Event authoring is owner-gated
      (``created_by_user_id == actor.id``), not RBAC-gated.

    Then it writes the event exactly as the HTTP handler did inline — the nested
    value-objects (``slot``, ``match_settings``, ``predicates``) persist as plain JSONB
    via ``model_dump``, the ``reservations`` as child **rows** through
    :func:`app.tournament_reservations.stored_reservations`, which composes them and
    stamps the server-assigned ``position`` the write shape has no field for, and the
    ``groups`` as rows the server materialises from the draw type and the preview
    field (:func:`app.tournament_reservations.materialise_groups`, #1387). Commits
    and refreshes before returning. Never raises ``HTTPException`` — the caller adapts
    each domain exception to its transport and shapes the read (a just-created event has
    no entrants, draw or results, so those are all empty without a query).

    The tournament's ``league_id`` — already in hand from the owner-load — is returned
    beside the event so the adapter can shape the caller's ``entry_state`` (the ladder
    it is judged on, ADR-0783) without re-querying the column the verb just loaded.
    """
    tournament = await _load_owned_tournament_for_update(db, tournament_id, actor)
    # The event's stages, also ROWS (ADR 20260815) and also created with the event in
    # this same transaction — every event holds its minted stages from the moment it
    # exists, never as a follow-up write. ``mint_stages`` reads the template straight
    # off the requested draw type; there is no separate "which stages" input on the
    # create payload, by design (decision 3: a director never authors these). Minted
    # BEFORE the event object below, so the event's own groups (composed next) have a
    # stage-0 row to hang off.
    stages = mint_stages(payload.draw_settings.draw_type)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name=payload.name,
        format=payload.format,
        # The event's draw configuration as a row, created here with the event and
        # flushed ahead of it by the relationship — the FK is NOT NULL, so an event
        # without one is not a row Postgres will accept. This is the ONLY place the
        # requested draw configuration is persisted; there is no column beside it to
        # keep in step.
        #
        # Written from the parsed union arm, never from the two loose payload fields:
        # the boundary has already refused a qualifier count that does not belong to
        # the draw type beside it (ADR 20260727), and ``draw_settings_row`` serializes
        # that arm onto the row's ``draw_type_id`` + ``settings`` pair in the one place
        # that knows how (ADR "a draw type's settings are one NOT NULL JSON object").
        draw_settings=draw_settings_row(payload.draw_settings),
        max_players=payload.max_players,
        entry_fee=payload.entry_fee,
        timezone=payload.timezone,
        slot=payload.slot.model_dump(),
        match_settings=payload.match_settings.model_dump(),
        predicates=[p.model_dump() for p in payload.predicates],
        stages=stages,
    )
    # What a client submits is a RESERVATION, and the server owns the groups (#1387).
    # ``stored_reservations`` turns the WRITE shape, which carries no ``position``,
    # into rows that do, from each entry's index in the list this payload sent; they
    # hang off the event. ``materialise_groups`` then mints the group rows onto the
    # event's stage 0 (ADR 20260815, "Sequencing with #1338") against the PREVIEW
    # field (the cap, or 16) — the one materialisation policy, the same function
    # ``update_event`` reaches through ``materialise_event_groups`` on every later
    # write, so a create and a patch cannot drift. Called on the stage directly rather
    # than through that door because the stage is a fresh, unflushed object with no id
    # to query by yet. Assigned onto the just-minted stage rather than passed into the
    # ``TournamentEvent`` constructor above: ``TournamentEvent.groups`` is a read-only
    # (VIEWONLY) association and would silently drop a write. ``event`` is already a
    # live Python object at this point (just not flushed yet), which is all the
    # reservations' own ``event`` relationship needs.
    event.reservations = stored_reservations(event, tournament, payload.reservations)
    materialise_groups(
        stages[0],
        event.reservations,
        draw_type=payload.draw_settings.draw_type,
        field_size=preview_field_size(payload.max_players),
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    await _reload_reservation_tables(db, event)
    return event, tournament.league_id


async def _reload_reservation_tables(db: AsyncSession, event: TournamentEvent) -> None:
    """Reload every reservation's ``tables`` after the ``refresh`` both write verbs end
    on, so the serializer that reads them next finds them loaded.

    The commit itself expires nothing (the sessionmaker is ``expire_on_commit=False``,
    ``app.db``). What empties the collection is ``db.refresh(event)``: it re-runs
    ``reservations``' own ``selectin`` load, and for a reservation this session already
    held — every one a patch KEPT, and every one a create composed before its INSERT —
    the chained ``selectin`` populates the row it finds in the identity map without
    re-running that row's own ``tables`` load, which is left unloaded. Under async an
    unloaded collection is a ``MissingGreenlet``, not a lazy load — so the tables are
    reloaded here, explicitly, in one statement per event rather than one per
    reservation. (A reservation a patch ADDED is a fresh object and arrives fully
    loaded; it is cheaper to reload all than to tell them apart.) Dropping this call
    reds ``test_group_materialisation`` on the PATCH path with that error.
    """
    await db.execute(
        select(TournamentEventReservation)
        .options(selectinload(TournamentEventReservation.tables))
        .where(TournamentEventReservation.event_id == event.id)
        .execution_options(populate_existing=True)
    )


async def delete_event(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
) -> None:
    """Delete the event ``event_id`` under the tournament ``actor`` owns.

    Loads the parent through :func:`_load_owned_tournament_for_update` (the tournament
    row lock, then the owner gate) and then the event through :func:`_load_event`, so
    the refusals are judged in the order the delete route kept:

    * **404** — an absent tournament id raises :class:`TournamentNotFoundError`.
    * **403** — a caller who is not the tournament's creator raises
      :class:`NotTournamentOwnerError` — judged before the event is even looked up, so
      a stranger never learns whether an event under it exists.
    * **404** — an event id that names no event under this tournament (a mismatched
      pair included) raises :class:`EventNotFoundError`.

    There is deliberately no further refusal: deleting an event carries no
    drawn/live guard (the delete route has none), so this issues the ``DELETE`` and
    commits it. Never raises ``HTTPException`` — the caller adapts each domain
    exception to its transport.

    The event's ``draw_settings`` row goes with it. That is the ORM's
    ``delete-orphan`` on :attr:`TournamentEvent.draw_settings`, not a database
    cascade — the FK points the other way, so Postgres cannot reap it — and it
    needs the event to be an ORM object, which is why this deletes the loaded
    ``event`` rather than issuing a ``DELETE ... WHERE id =``. The two statements
    are ordered by the unit of work: the event holds the ``ON DELETE RESTRICT`` FK,
    so its row goes first and the settings row it named goes second.
    """
    await _load_owned_tournament_for_update(db, tournament_id, actor)
    event = await _load_event(db, tournament_id, event_id)
    await db.delete(event)
    await db.commit()


def _group_set_frozen_detail(
    removed: list[str], added: int, *, removed_unmapped: int = 0
) -> str:
    """The 409 sentence for a reservations payload that would change *which
    reservations* a cut event has, and through them which groups can play where
    (:class:`GroupSetFrozenError` carries it as its body).

    Both halves are reported, because a payload can move both at once. A **removed**
    reservation leaves every group mapped to it with nowhere to play — and those
    groups already have fixtures drawn into them, so they are **named**, by the label
    each one's position derives (``Group G``, ``app.draws.group_label``; a group has no
    name column). An **added** reservation is **counted**, not named, and the clause
    says why it is refused now that a group count creates no reservation (#1387
    decision 4): each group was mapped to a reservation at the cut and nothing
    re-maps one afterwards, so the new reservation could hold no group — a table set
    this event's fixtures can never reach, with nothing on screen saying why. The
    sentence ends with what is still allowed and with the way out (remove the draw,
    change the reservations, cut again), so a director who has to move a broken table
    is never left with nowhere to go.

    ``removed_unmapped`` counts removed reservations that no group maps onto — an
    event deriving one group across four reservations has three such — so a removal
    that strands no group is still refused with a sentence that has a clause in it:
    the set is identity once a draw exists, whether or not a group sits on every
    member of it.

    It no longer offers "re-identify" as a third thing to do: a reservation id is minted
    by the server (ADR 20260801), so re-identifying one is not a payload a client can
    send.
    """
    clauses = []
    if removed:
        clauses.append(
            f"{named_list(removed)} already has fixtures drawn into it, "
            "which this change would leave with no reservation to play in"
        )
    if removed_unmapped:
        clauses.append(
            f"{removed_unmapped} "
            f"{'reservation' if removed_unmapped == 1 else 'reservations'} would be "
            "removed, and the groups were mapped to the reservations this event had "
            "when the draw was cut"
        )
    if added:
        clauses.append(
            f"{added} new {'reservation' if added == 1 else 'reservations'} could hold "
            "no group, because each group was mapped to a reservation when the draw "
            "was cut and nothing re-maps one until the draw is removed"
        )
    return (
        "This event's draw is already cut, so its set of reservations is frozen: "
        + "; and ".join(clauses)
        + ". A reservation's tables, its time and its name can all still be changed. "
        "To add or remove a reservation, remove the draw first, then cut it again."
    )


def _group_order_frozen_detail(names: list[str]) -> str:
    """The 409 sentence for a reservations payload that cites exactly the reservations
    a cut event already has, in a **different order** — the freeze's second way to fire,
    beside the set changing (ADR-0786, extended: the mapping is identity once fixtures
    exist).

    A group maps to the reservation at ``position % reservation count``, read at the
    cut and never again (#1387 decision 3). Reordering the reservations would leave the
    stored mapping true and the rule it was derived from false: the reservation a
    group plays in would no longer be the one its position names, and the next thing
    to re-derive the mapping — an uncut, then a write — would move every group to a
    different table set than the director is looking at. ``names`` are the groups, by
    derived label, so the sentence says which groups the frozen mapping holds.

    Deliberately its own sentence rather than a fold into
    :func:`_group_set_frozen_detail` above: that one names what is *lost* and counts
    what is *gained*, and a reorder does neither — the honest complaint is about the
    order, not the membership, so the director is told that.
    """
    return (
        "This event's draw is already cut, so the order of its reservations is frozen "
        f"({named_list(names)} play in them): each group was mapped to a reservation "
        "by position when the draw was cut, and nothing re-maps one until the draw is "
        "removed. A reservation's tables, its time and its name can all still be "
        "changed. To reorder the reservations, remove the draw first, then cut it "
        "again."
    )


def _draw_type_frozen_detail(current: DrawType) -> str:
    """The 409 sentence for a ``draw_type`` change on an event whose draw is already cut
    — composed exactly as the router's ``_draw_type_refusal`` used to compose it inline,
    so :class:`DrawTypeFrozenError` carries the byte-identical body.

    It says *how* to get unstuck, because the alternative is a stuck director: the
    draw type chose the strategy that dealt these fixtures, so an event that is
    ``single-elim`` while holding grouped round-robin fixtures is claiming a shape its
    own draw does not have: the fixtures carry a ``group_id`` that a bracket has no
    groups to name. The refusal names the way out — remove the draw, then re-cut, and
    the new strategy deals fixtures that match the type.
    """
    return (
        f"This event's draw is already cut, so its draw type is frozen: its "
        f"fixtures were dealt as a “{current.value}” draw, and changing the type "
        "would leave the event claiming a shape its draw does not have. To change "
        "the draw type, remove the draw first, then cut it again."
    )


def _qualifiers_per_group_frozen_detail(
    current: DrawType, qualifiers: int | None
) -> str:
    """The 409 sentence for a ``qualifiers_per_group`` change on an event whose draw is
    already cut — the same freeze as the draw type's, about the other half of the same
    configuration (ADR 20260727).

    It is not hypothetical and it is not cosmetic. The knockout bracket is cut
    **upfront** from ``P × K``, and the qualifiers are seated into predetermined slots
    as each group finishes: a bracket cut at ``K = 2`` and then advanced at ``K = 3``
    has three groups' worth of thirds with nowhere to sit. So the count is frozen
    exactly as the type is, and the way out is the same one.

    This is the **first** line of defence, not the only one: past it,
    :meth:`app.draws.RrThenKoStrategy.advance` raises
    :class:`~app.draws.MissingBracketSlot` rather than seating the qualifiers it finds
    slots for and dropping the rest. Which is why the 409 is worth having — it is the
    refusal a director can act on, in their own language, before the domain has to shout
    about a state nothing they typed could have produced.
    """
    return (
        "This event's draw is already cut, so the number of qualifiers per group is "
        f"frozen: its knockout bracket was cut for the top {qualifiers} out of each "
        f"group of a “{current.value}” draw, and changing that count would leave "
        "qualifiers with no slot to be seated into. To change it, remove the draw "
        "first, then cut it again."
    )


def _rounds_frozen_detail(rounds: int | None) -> str:
    """The 409 sentence for a ``rounds`` change on a swiss event whose draw is already
    cut — the qualifier count's sibling, about the other configured setting.

    Not hypothetical either: a swiss draw writes **every** round's fixtures at the cut
    (ADR "swiss pre-cuts every round and pairs each one on advance"), so the round count
    is the number of rows standing in the database. Raising it would leave the added
    rounds with no fixtures and lowering it would leave fixtures no round claims.
    """
    round_noun = "round" if rounds == 1 else "rounds"
    return (
        "This event's draw is already cut, so its number of rounds is frozen: all "
        f"{rounds} {round_noun} were cut at once, and changing the count would leave "
        "the draw with rounds it has no fixtures for. To change it, remove the draw "
        "first, then cut it again."
    )


def _draw_settings_frozen_detail(stored: DrawSettingsWriteArm) -> str:
    """The 409 sentence for a settings change on an event whose draw type is unchanged —
    which setting moved is a question about the arm, so it is asked of the arm.

    An exhaustive ``match`` with no catch-all: a draw type that grows a setting is a
    type error here until it says how a change to it reads."""
    match stored:
        case RrThenKoDrawSettingsWrite():
            return _qualifiers_per_group_frozen_detail(
                stored.draw_type, stored.qualifiers_per_group
            )
        case SwissDrawSettingsWrite():
            return _rounds_frozen_detail(stored.rounds)
        case RoundRobinDrawSettingsWrite() | SingleElimDrawSettingsWrite():
            # Unreachable: these arms carry no setting, so an incoming arm of the same
            # draw type is EQUAL to the stored one and the caller has already returned.
            # Answered with the draw type's own sentence rather than an ``assert``,
            # because the honest fallback for "the configuration moved" is to name the
            # configuration.
            return _draw_type_frozen_detail(stored.draw_type)


async def _enforce_group_set_frozen(
    db: AsyncSession, event: TournamentEvent, updates: TournamentEventUpdate
) -> None:
    """Raise :class:`GroupSetFrozenError` once a ``reservations`` payload would change
    *which reservations* an event with a cut draw has, **or the order they stand in**
    (ADR-0786, #1387 decisions 3 and 4).

    **What is frozen is the mapping, and what the payload diffs is reservations.** At
    the cut every group was mapped to the reservation at ``position % reservation
    count``, and nothing re-maps a group while the draw stands. So remove a reservation
    and every group mapped to it — with fixtures already drawn into it — has nowhere to
    play; add one and it can hold no group, because the mapping will not be re-read
    until the draw is removed; reorder them and the stored mapping no longer follows
    from the positions it was derived from. The comparison runs in the reservation's
    id space (the one the wire lets a client cite) against ``event.reservations``, and
    it reports in the group's terms, naming by derived label the groups a removed
    reservation would strand.

    **What this guard does not do, since #1387.** It does not compare a group count
    against anything. The count derives from the preview field before the cut and
    from the real field at the cut, and those are different numbers on purpose, so a
    guard that compared a stored count against a re-derived one would refuse a rename
    forever (derive from the cap) or refuse the next unrelated edit after a walk-in
    (derive from the real field). A ``max_players`` change on a cut event succeeds and
    moves no group row; every event edit that is not a reservation add, remove or
    reorder succeeds.

    * **Re-identifying** a reservation — citing an id the server never minted — is
      caught by :func:`~app.tournament_reservations.apply_event_reservations`'s own
      422, not here, though in practice it always widens the "added" side of this
      guard too (an unknown id contributes nothing to ``incoming``).
    * **Removing** a reservation: the join row's foreign key cascades the mapping away
      silently, and the database says nothing about the groups left without one, so
      this is the only thing standing between a director and a draw whose fixtures
      have no window.
    * **Adding** a reservation: no constraint says anything at all.
    * **Reordering** the same set: only ``position`` moves, so again nothing a
      constraint could answer.

    A reservation's ``table_ids``, its ``slot`` and its ``name`` stay editable with a
    draw standing, on purpose — this is the case the freeze exists to *permit*, not to
    prevent.

    Asked **before** anything is written (and, like every judge-then-write guard, under
    the tournament's row lock the verb holds), so a refusal leaves both the reservations
    and the fixtures exactly as they were — never written, not merely rolled back. It is
    also asked before
    :func:`~app.tournament_reservations.apply_event_reservations`'s own 422 for an id
    this event does not have, so a cut event answers the 409 that names its groups.
    With **no draw cut** this is a no-op and the diff applies as it always has.
    """
    # An absent ``reservations`` key is the only way this is ``None`` — an explicit
    # ``null`` is a 422 at the schema (the column is NOT NULL) — so "not sent" is the
    # whole meaning of it, and an event whose reservations are not being replaced has
    # nothing here to enforce.
    if updates.reservations is None:
        return
    # The freeze turns on the draw EXISTING, not on it having been played: an unplayed
    # draw is the ordinary state of a tournament that has not started, and it is just as
    # orphanable as a played one.
    if not await event_has_draw(db, event.id):
        return
    # The reservations the event holds, in their stored order (``event.reservations``
    # is eager).
    existing_order = [reservation.id for reservation in ordered_reservations(event)]
    # An entry with no ``id`` is an addition and contributes nothing to the incoming
    # SEQUENCE — which is what makes ``existing_order == incoming_order`` "you cited
    # exactly the reservations you have, in the order you have them" rather than merely
    # "you sent the same number of them".
    incoming_order = [
        entry.id for entry in updates.reservations if entry.id is not None
    ]
    if existing_order == incoming_order and len(updates.reservations) == len(
        incoming_order
    ):
        return
    existing = set(existing_order)
    incoming = set(incoming_order)
    # The groups, in position order: the rows a refusal NAMES, by the label each
    # position derives (ADR 20260808, ``group_label``) — a group has no name column.
    current = sorted(event_groups(event), key=lambda group: group.position)
    # A removed reservation strands every group mapped to it; those groups are the
    # ones named. An added reservation is COUNTED — it has no identity yet. An entry
    # citing an id this event does not have counts as an addition here — it is one in
    # effect, and past this guard it is the 422 ``apply_event_reservations`` raises.
    removed = [
        group_label(group.position)
        for group in current
        if group.reservation_id is not None and group.reservation_id not in incoming
    ]
    added = sum(
        1
        for entry in updates.reservations
        if entry.id is None or entry.id not in existing
    )
    # A removed reservation no group maps onto strands nothing and is refused all the
    # same: the set is identity once a draw exists. Counted so the sentence has a
    # clause for it (see :func:`_group_set_frozen_detail`).
    mapped = {group.reservation_id for group in current}
    removed_unmapped = sum(
        1 for reservation_id in existing - incoming if reservation_id not in mapped
    )
    if removed or added or removed_unmapped:
        raise GroupSetFrozenError(
            _group_set_frozen_detail(removed, added, removed_unmapped=removed_unmapped),
            removed=removed,
            added=added,
        )
    # The set is unchanged (this is the ``existing_order != incoming_order`` branch
    # that falls through the equality check above with an equal SET) — so what moved
    # is purely the order, which the set comparison could never see. Its own sentence,
    # not a fold into the set refusal above: no reservation was gained or lost, so the
    # honest complaint is about the sequence, and the director is told that.
    raise GroupSetFrozenError(
        _group_order_frozen_detail([group_label(group.position) for group in current]),
        removed=[],
        added=0,
    )


async def _enforce_draw_settings_frozen(
    db: AsyncSession, event: TournamentEvent, updates: TournamentEventUpdate
) -> None:
    """Raise :class:`DrawTypeFrozenError` once a draw-configuration payload would change
    the **draw type or the setting that goes with it** — rr-then-ko's qualifier count,
    swiss's round count — on an event that **has a draw** (ADR-0786, ADR 20260727, and
    the swiss ADR).

    A draw type is not a label on an event — it is the strategy that dealt the event's
    fixtures, and the fixtures are the shape that strategy prescribes. Patch it under a
    standing draw and the two facts contradict each other. The go-live currency check
    cannot catch it (currency compares the seated entrant set against the active
    entrants, and re-labelling moves neither), which is why this guard has to exist.

    ``qualifiers_per_group`` is frozen by the **same** guard rather than a parallel one,
    because it is the same fact wearing a second column: an ``rr-then-ko`` draw's
    bracket is cut upfront for ``P × K``, so a K the fixtures were not cut for is
    exactly as contradictory as a type they were not dealt by — and quieter (see
    :func:`_qualifiers_per_group_frozen_detail`). Swiss's ``rounds`` is frozen by that
    same guard for that same reason: all ``R`` rounds are cut at once, so an R the
    fixtures were not cut for leaves the draw with rounds it has no fixtures for (see
    :func:`_rounds_frozen_detail`). One comparison over the whole configuration is also
    what keeps a payload that moves *both* from being judged twice.

    **Presence is not enough — the change is what is refused.** A configuration equal to
    the one the event already has changes nothing, so a page PATCHing the whole event
    form back (draw type and count included) to move a group's tables is the very edit
    the freeze exists to permit. Asked **before** anything is written, under the
    tournament's row lock the verb holds.

    What the event *currently* has is read off its ``draw_settings`` row — the one home
    of that fact (ADR "an event's draw configuration is a row, not a column") — and read
    once, before the caller's ``setattr`` loop, so what is compared is the stored
    configuration and not the one the payload is asking for. Both sides of the
    comparison are the **parsed arm**, so "did the configuration move" is one equality
    over the whole union rather than a field-by-field walk that a new setting could fall
    out of.
    """
    # ``None`` is "this patch does not touch the draw configuration": the schema refuses
    # an explicit ``null`` on ``draw_type`` (422) and refuses a ``qualifiers_per_group``
    # with no ``draw_type`` beside it, so an absent draw type means an absent pair.
    incoming = updates.draw_settings
    if incoming is None:
        return
    stored = draw_settings_of(event.draw_settings)
    if incoming == stored:
        return
    current = stored.draw_type
    # Only now the query — and only for a payload that really moves the configuration.
    # It is the same ``event_has_draw`` the group freeze asks; a payload that changes
    # both
    # asks it twice — two COUNTs on an indexed column under a lock we hold, in exchange
    # for two guards that each read as one rule.
    if not await event_has_draw(db, event.id):
        return
    # The draw type is named first when both moved: it is the bigger claim, and the
    # qualifier-count sentence would be describing a bracket the event is no longer
    # asking to have.
    detail = (
        _draw_type_frozen_detail(current)
        if incoming.draw_type is not current
        else _draw_settings_frozen_detail(stored)
    )
    raise DrawTypeFrozenError(detail, draw_type=current.value)


def _enforce_reservation_cap(
    event: TournamentEvent, updates: TournamentEventUpdate
) -> None:
    """Raise :class:`EventReservationCapExceededError` once this PATCH would leave a
    non-``rr-then-ko`` event holding more than one reservation (#1482), by calling
    :func:`app.schemas.tournament.enforce_event_reservation_cap` — the one function
    both this call site and the create schema's validator use.

    Judged on the **effective** pair, not merely on what this payload sends, so a
    patch that touches only one half of the pair is still judged against the state
    it would leave the event in: the draw type is ``updates.draw_settings.draw_type``
    when this patch touches the draw configuration, else the event's stored one
    (:func:`~app.tournament_draw_settings.draw_settings_of`); the reservation count
    is ``len(updates.reservations)`` when this patch replaces the reservations, else
    the event's stored count. The stored count is read off ``event.reservations``
    via :func:`~app.tournament_reservations.ordered_reservations` — the same eager
    access :func:`_enforce_group_set_frozen` already uses — rather than a fresh
    query, since the caller already holds the event with that relationship loaded.

    Asked **after** :func:`_enforce_group_set_frozen` and
    :func:`_enforce_draw_settings_frozen`, and before anything is written: the freeze
    is the refusal a director can act on (remove the draw, then edit), so a cut event
    over the cap answers the freeze's 409 first, and only an uncut event (or one
    whose payload leaves the freezes satisfied) reaches this 422.

    **A no-op on a patch that touches neither half of the pair.** A legacy event
    already over the cap (data only reachable pre-#1482, since both write paths now
    refuse to create one) must still accept an edit to its name, its fee, or anything
    else that is not itself a reservations-or-draw-type write — the same contract
    :func:`_enforce_group_set_frozen` already states for the freeze ("every event
    edit that is not a reservation add, remove or reorder succeeds"). A cap that
    fired on every patch to such a row, whatever the payload touched, would turn its
    mere existence into a standing refusal — which is not what "at most one
    reservation, going forward" means.

    **That escape hatch serves API and MCP callers, not the event editor.** The web
    client's ``eventToUpdateBody`` always spreads ``reservations`` and always takes
    ``draw_type`` off ``drawSettingsToApi`` (deliberately, and pinned by
    ``web-client/src/components/tournaments/data/api.test.ts``), so **every** save
    from the editor touches the pair and none of them reach this early return — a
    legacy over-cap event is refused in the editor by the client's own resolver rule
    before a request is even built. A caller that patches one field at a time is the
    only one this branch is reachable from, and it is the one that needs it: without
    it, such a row could never be renamed, only deleted.
    """
    if updates.reservations is None and updates.draw_settings is None:
        return
    incoming_draw_settings = updates.draw_settings
    draw_type = (
        incoming_draw_settings.draw_type
        if incoming_draw_settings is not None
        else draw_settings_of(event.draw_settings).draw_type
    )
    reservation_count = (
        len(updates.reservations)
        if updates.reservations is not None
        else len(ordered_reservations(event))
    )
    enforce_event_reservation_cap(draw_type, reservation_count)


def _enforce_reservation_containment(
    event: TournamentEvent, updates: TournamentEventUpdate
) -> None:
    """Raise :class:`ReservationOutsideEventWindowError` once this PATCH would leave a
    reservation outside its event's own ``slot`` (#1501), by calling
    :func:`app.schemas.tournament.enforce_reservation_containment` — the one function
    both this call site and the create schema's validator use.

    **The effective-pair pattern, exactly as** :func:`_enforce_reservation_cap` **above
    plays it.** The event window judged is ``updates.slot`` when this patch touches the
    event's own slot, else the event's stored one; the reservations judged are
    ``updates.reservations`` when this patch touches them, else the event's stored ones
    (:func:`~app.tournament_reservations.ordered_reservations`, the same eager access
    :func:`_enforce_group_set_frozen` and :func:`_enforce_reservation_cap` already use).
    So a PATCH that shortens the event's slot under a stored reservation is refused
    naming that reservation, and a PATCH that widens a reservation past the event's
    stored slot is refused too — each half of the pair is judged against the truth the
    OTHER half would leave standing.

    **The escape hatch, checked FIRST — before ``event.slot`` is ever read.** A patch
    touching neither ``slot`` nor ``reservations`` is not judged at all, the same
    contract :func:`_enforce_reservation_cap` states for the cap: a legacy event already
    violating the rule (unreachable through either write path once this guard exists)
    must still accept a rename, a fee change, or anything else that is not itself a
    window edit. Checking this before touching ``event.slot`` is not just the policy —
    it is what keeps the read below TOTAL: a row that already violates the rule may
    also hold a malformed stored slot, and reading it before the early return would turn
    an unrelated rename into a 500, which is this ticket's own bug relocated to the
    verb that was supposed to fix it.

    **The stored event slot is read as a total function, not a parse.** ``event.slot``
    is still the untyped JSONB dict (three keys, no columns behind it), and
    ``date.fromisoformat``/``time.fromisoformat`` run with no ``try``/``except`` around
    them — mirroring the stated precedent at
    :func:`app.tournament_reservations._slot_columns`: no environment holds a malformed
    stored event slot (#1501's Evidence, and the repo's no-data-preservation decision),
    so this is a total function of what can reach it. Recorded here, deliberately, so
    the choice is examined rather than inherited the next time someone reads this
    function.

    Asked **after** :func:`_enforce_reservation_cap` in the guard chain
    (``update_event`` below), which is itself already after both freezes: a cut event
    over the cap still answers the cap's 422 before this one, and a cut event at all
    still answers a freeze's 409 before either.
    """
    if updates.reservations is None and updates.slot is None:
        return
    if updates.slot is not None:
        event_window = (
            date.fromisoformat(updates.slot.date),
            time.fromisoformat(updates.slot.start),
            time.fromisoformat(updates.slot.end),
        )
    else:
        stored_slot = event.slot
        event_window = (
            date.fromisoformat(stored_slot["date"]),
            time.fromisoformat(stored_slot["start"]),
            time.fromisoformat(stored_slot["end"]),
        )
    if updates.reservations is not None:
        reservations = reservation_windows(updates.reservations)
    else:
        reservations = [
            ReservationWindow(
                position=stored.position,
                name=stored.name,
                slot_date=stored.slot_date,
                slot_start=stored.slot_start,
                slot_end=stored.slot_end,
            )
            for stored in ordered_reservations(event)
        ]
    enforce_reservation_containment(event_window, reservations)


def _event_scheduling_facts(
    event: TournamentEvent,
) -> tuple[tuple[tuple[uuid.UUID, Slot, tuple[str, ...]], ...], int, str]:
    """The slice of an event the schedule solver actually reads (ADR "the schedule is
    solved; the call is pinned"), in a comparable shape — what the update verb compares
    before/after its write to decide whether a re-solve is owed.

    Exactly three facts feed ``_load_solver_inputs``: each reservation's identity,
    window and tables (its *name* is display and deliberately absent — a reservation
    rename must not spend a solve), ``match_settings.length_games`` (duration input;
    ``rated`` is a results rule the solver never sees), and the event ``timezone`` — the
    anchor that turns each Slot's wall-clock ``{date,start,end}`` into the real instant
    the solver compares against ``now``. Without the timezone here a tz-only correction
    re-anchors every placement but compares equal, so a stale
    ``infeasible``/``past_window`` verdict would never be re-solved away. Parsed
    through the same models the write boundary validated the JSONB with (parse, don't
    validate), and read off the ROW not the payload, so "changed" means the row
    changed — a PATCH that re-sends the values the event already holds compares equal
    and triggers nothing.
    """
    settings = MatchSettings.model_validate(event.match_settings)
    return (
        tuple(
            (reservation.id, reservation.slot, tuple(reservation.table_ids))
            for reservation in event_reservations(event)
        ),
        settings.length_games,
        event.timezone,
    )


async def _reanchor_placements_for_timezone_change(
    db: AsyncSession,
    event_id: uuid.UUID,
    *,
    old_timezone: str,
    new_timezone: str,
) -> None:
    """Preserve the **wall-clock** of an event's manual placements across a timezone
    edit (ADR "tournament times are timezone-aware instants" — "Wall-clock is preserved
    across a timezone edit").

    A director who placed a fixture at 18:00 in ``America/Chicago`` and then corrects
    the event to ``America/Denver`` means "the match is at 6 PM local; I just fixed
    which local" — so the fixture must still read **18:00**, its stored instant moving
    by the offset delta while its local reading stays put. The group ``Slot`` windows
    get this for free (wall-clock ``{date,start,end}`` components, untouched by the
    edit); ``scheduled_start`` is a ``timestamptz`` **instant**, so it is recomposed
    here or it would silently shift.

    Only ``scheduled_start`` is recomposed — never ``pinned_at``. ``scheduled_start`` is
    a wall-clock *intent* ("the match is at 6 PM local"), so correcting which local
    means recomposing it to keep the intended reading; ``pinned_at`` is the real instant
    the call/notification actually fired, an event-log timestamp — not an intent — so
    its stored instant is left fixed and the detail BFF re-renders that same instant in
    the new zone.

    Recovery is: read ``scheduled_start``'s wall-clock **in the OLD zone** (the one the
    director saw when placing it), then re-anchor those same components in the NEW zone
    — the same ``.replace(tzinfo=...)`` composition the window instants use, so a
    wall-clock that lands in a DST gap/fold resolves one consistent way not crashing.
    Only
    rows that actually carry a ``scheduled_start`` are read. The caller invokes this
    **only when the zone truly changed**, on its open transaction under the tournament
    row lock, so the recompose commits atomically with the ``timezone`` write.
    """
    old_tz = ZoneInfo(old_timezone)
    new_tz = ZoneInfo(new_timezone)

    def _reanchor(instant: datetime) -> datetime:
        wall_clock = instant.astimezone(old_tz).replace(tzinfo=None)
        return wall_clock.replace(tzinfo=new_tz)

    # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5); the event
    # is reachable through the stage.
    placed = (
        (
            await db.execute(
                select(TournamentFixture).where(
                    TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])),
                    TournamentFixture.scheduled_start.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for fixture in placed:
        if fixture.scheduled_start is not None:
            fixture.scheduled_start = _reanchor(fixture.scheduled_start)


async def update_event(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
    updates: TournamentEventUpdate,
) -> tuple[TournamentEvent, uuid.UUID]:
    """Apply the partial ``updates`` to an event under the tournament ``actor`` owns,
    and return the refreshed :class:`TournamentEvent` together with the tournament's
    ``league_id``.

    Loads the parent through :func:`_load_owned_tournament_for_update` (the tournament
    row lock, then the owner gate) and then the event through :func:`_load_event`, so
    the refusals are judged in the order the update route kept — **404 → 403 → 409**
    (ADR-0017), the state of this event's draw never the reason a stranger's request is
    refused:

    * **404** — an absent tournament id raises :class:`TournamentNotFoundError`.
    * **403** — a caller who is not the tournament's creator raises
      :class:`NotTournamentOwnerError`. Event mutations are owner-gated, not RBAC-gated.
    * **404** — an event id that names no event under this tournament raises
      :class:`EventNotFoundError`.
    * **409** — once the event's draw is cut, two things freeze (ADR-0786): a ``groups``
      payload that changes *which groups* the event has, **or the order they stand in**,
      raises :class:`GroupSetFrozenError`, and a draw-configuration payload that changes
      the draw type **or its qualifier count** (ADR 20260727) raises
      :class:`DrawTypeFrozenError`. Both are judged **before** anything is
      written, so a refusal persists nothing.

    Then the partial apply (``model_dump(exclude_unset=True)`` serializes the nested
    value-objects to plain dicts/lists, so one ``setattr`` loop covers the JSONB and
    scalar columns alike — with ``groups`` taken out of it and applied as an id-keyed
    diff over the event's group **rows**,
    :func:`app.tournament_reservations.apply_event_reservations`), with three side
    effects — the first new, the other two preserved exactly from the router:

    * a **draw-configuration** edit (the draw type and, for ``rr-then-ko``, its
      qualifier count) is applied to the event's ``draw_settings`` row, the only place
      an event's draw configuration is stored. Both are deliberately taken out of the
      ``setattr`` loop: there is no ``draw_type`` attribute on the mapped event, so
      the loop would bind an unmapped Python attribute and drop the edit;
    * a **timezone** edit re-anchors every placed fixture's ``scheduled_start`` so its
      wall-clock reading is unchanged and only its stored instant shifts
      (:func:`_reanchor_placements_for_timezone_change`), captured against the OLD zone
      before the ``setattr`` loop overwrites it;
    * when the solver-visible facts (:func:`_event_scheduling_facts`) changed AND this
      event has a cut draw, a ``settings_changed`` solve is requested inside this
      transaction under the row lock. A ``None`` return (Redis down) is deliberately
      ignored — the edit is what the owner asked for, and the missing solve is recovered
      by the pin tick or the Run-scheduler button.

    Commits and refreshes before returning. Never raises ``HTTPException`` — the caller
    adapts each domain exception to its transport and shapes the read (an edited event
    keeps its entrants, draw and results, which the adapter reloads).

    The tournament's ``league_id`` — already in hand from the owner-load — is returned
    beside the event so the adapter can shape the caller's ``entry_state`` (the ladder
    it is judged on, ADR-0783) without re-querying the column the verb just loaded.
    """
    # The owner-load locks the tournament row and gates on ownership (404 → 403); the
    # LOCK it takes is held for the rest of this transaction — the freezes and the
    # re-solve trigger below run under it — and its ``league_id`` is returned to the
    # adapter so the read it shapes need not re-query that column.
    tournament = await _load_owned_tournament_for_update(db, tournament_id, actor)
    event = await _load_event(db, tournament_id, event_id)
    # 404 → 403 → 409: the freezes are asked before the setattr loop below, so a
    # refusal writes nothing at all.
    await _enforce_group_set_frozen(db, event, updates)
    await _enforce_draw_settings_frozen(db, event, updates)
    # The reservation cap (#1482) is judged after both freezes: the freeze is the
    # refusal a director can act on, so a cut event over the cap answers the 409 that
    # names its groups before this 422.
    _enforce_reservation_cap(event, updates)
    # Containment (#1501) is judged last of the four: after both freezes and the cap,
    # so a cut event over the cap still answers the cap's 422 first, and a cut event
    # at all still answers a freeze's 409 first.
    _enforce_reservation_containment(event, updates)
    # Read ONCE, under the row lock, for the two gates below (the materialisation and
    # the re-solve trigger): a draw is cut or removed only under this same lock, so
    # the answer cannot move between here and the commit.
    has_draw = await event_has_draw(db, event.id)
    facts_before = _event_scheduling_facts(event)
    # Captured BEFORE the setattr loop overwrites it: a timezone edit preserves the
    # wall-clock of already-placed fixtures, which needs the zone they were placed IN to
    # recover it.
    old_timezone = event.timezone
    changes = updates.model_dump(exclude_unset=True)
    # Neither half of the draw configuration is a column on the event — the draw type is
    # the ``draw_type_id`` FK on the settings row the event points at, and the
    # qualifier count is a key inside that row's ``settings`` JSON object — so both are
    # routed OUT of
    # the generic setattr loop rather than through it. This is not decoration:
    # SQLAlchemy's declarative instances accept any attribute, so
    # ``setattr(event, "draw_type", ...)`` would bind a plain Python attribute the
    # mapper
    # never persists — the edit would be silently accepted and silently dropped. Popping
    # them leaves the loop below touching mapped columns only.
    changes.pop("draw_type", None)
    changes.pop("qualifiers_per_group", None)
    # The swiss round count is the same kind of key for the same reason: it lives in the
    # settings row's JSON object, not on the event, so the loop would bind an unmapped
    # attribute and drop the edit silently.
    changes.pop("rounds", None)
    # Reservations (and their mapped groups) are rows, so they are taken OUT of the
    # generic setattr loop entirely and applied as a diff
    # (:func:`app.tournament_reservations.apply_event_reservations`) — assigning the
    # dumped payload would put dicts where the relationship expects
    # ``TournamentEventStageGroup``s, and a wholesale replace would delete and recreate
    # the very rows this event's fixtures foreign-key. The diff also stamps the order
    # the patch sent, on this verb as much as on create: an event born positioned and
    # then patched flat is the "the patch path is the hole" bug this repo keeps
    # rediscovering. ``is not None`` is exactly "the key was sent": an explicit ``null``
    # is already a 422 (``TournamentEventUpdate._reject_explicit_null``), so this cannot
    # be mistaking a clear for an absence. The applying happens after the loop below,
    # with the other writes, so a payload that touches nothing else still reaches it.
    #
    # The dict key here is ``"reservations"`` — ``TournamentEventUpdate``'s own field
    # name — never ``"groups"``: the schema carries no such field, so popping that key
    # was a no-op and left ``"reservations"`` in ``changes``, which the generic loop
    # below then tried to ``setattr`` onto the event's VIEWONLY ``groups`` association
    # (a lazy relationship, not a plain column) — a lazy load in a sync context that
    # SQLAlchemy's async extension refuses with ``MissingGreenlet``.
    changes.pop("reservations", None)
    # The parsed union arm, not the loose keys: it is ``None`` exactly when the patch
    # does not touch the draw configuration, and when it is not, the pair it carries is
    # one the write union accepted at the request boundary (ADR 20260727). That union is
    # the only thing that checks the pairing now — the settings table's ``CASE``
    # ``CHECK`` was dropped with the column it named.
    draw_settings = updates.draw_settings
    for key, value in changes.items():
        setattr(event, key, value)
    if updates.reservations is not None:
        await apply_event_reservations(db, tournament, event, updates.reservations)
    if draw_settings is not None:
        # Captured BEFORE ``store_draw_settings`` overwrites it: the re-mint gate below
        # needs to know whether the TYPE actually moved, and the setter is the only
        # place ``event.draw_settings.draw_type`` changes.
        old_draw_type = event.draw_settings.draw_type
        # The one place an event's draw configuration moves after create (the freeze
        # above has already refused this on a cut draw). Assigned through
        # ``store_draw_settings``, not through the row's columns, so serializing the arm
        # onto ``draw_type_id`` + ``settings`` stays in the single place that owns it —
        # the same door ``draw_settings_row`` goes through at create. That matters most
        # on THIS path: a draw type patched from ``rr-then-ko`` back to ``round-robin``
        # has to drop the qualifier count with it, and writing the pair together is what
        # makes that automatic. The settings row is loaded with the event
        # (``lazy="joined"``), so this is a plain attribute write, not a lazy load in
        # async context.
        store_draw_settings(event.draw_settings, draw_settings)
        # Re-apply the stage template IN PLACE (ADR 20260815 decision 3) — but only when
        # the draw TYPE itself moved. The stage template ``stage_template`` mints
        # depends only on ``draw_type`` (never on the settings beside it, e.g.
        # ``qualifiers_per_group``), so a settings-only edit on an unchanged type has
        # nothing for a re-mint to do. This also covers the one case
        # ``_enforce_draw_settings_frozen`` waves through even under a standing draw — a
        # PATCH that resends the event's current draw settings unchanged — because that
        # case never moves the type either.
        #
        # No ``event_has_draw`` COUNT needed to prove safety here, unlike the old gate:
        # whenever ``draw_settings.draw_type is not old_draw_type``, the freeze above
        # has ALREADY refused this same request had a draw existed (it compares the
        # incoming arm against the stored one and raises on any real move under a cut
        # draw) — so reaching this line with a moved type means the event has no draw,
        # without asking the database again.
        if draw_settings.draw_type is not old_draw_type:
            await remint_stages_in_place(db, event, draw_settings.draw_type)
    if event.timezone != old_timezone:
        # The zone truly moved (a PATCH re-sending the same zone falls through as a
        # no-op): recompose every placement so its local reading is unchanged and only
        # its stored instant shifts by the offset delta. The Slot windows stay put.
        await _reanchor_placements_for_timezone_change(
            db, event.id, old_timezone=old_timezone, new_timezone=event.timezone
        )
    # The groups are the server's, re-materialised on EVERY write while the event has
    # no draw (#1387) — unconditionally, not only when the patch carried a
    # ``reservations`` key, because a patch of ``max_players`` alone or ``draw_type``
    # alone moves the count too. Late, on purpose, and two orderings force the spot:
    # after the reservations diff above, or the groups would map onto a stale
    # reservation set; and after ``store_draw_settings``, or a patch TO ``rr-then-ko``
    # would read the old type and materialise nothing. ``remint_stages_in_place`` is
    # safe to sit before it: stage 0 keeps its row identity across a re-mint (ADR
    # 20260815 decision 3), so the groups hanging off it survive.
    #
    # Gated on the draw NOT existing (decision 3): once a draw is cut nothing
    # recomputes the count, so a cap change on a cut event succeeds and moves no
    # group row, and the freeze above is the only thing that speaks to the set.
    if not has_draw:
        await materialise_event_groups(
            db, event, field_size=preview_field_size(event.max_players)
        )
    # Flushed before the facts are re-read, because one of them is a reservation's
    # ``id`` and a reservation this payload ADDED does not have one until the INSERT
    # runs: the id is the database's (``gen_random_uuid()``), not the client's, so an
    # unflushed row would project as ``id=None`` and the read boundary would refuse
    # it. The same goes for a group the materialisation just minted. Flushing is safe
    # here for the same reason the diff is: both position constraints and the
    # fixture's composite foreign key are DEFERRABLE INITIALLY DEFERRED, so an
    # intermediate state is nobody's business until COMMIT.
    await db.flush()
    if has_draw and facts_before != _event_scheduling_facts(event):
        # Gated on THIS event having a cut draw — stricter than the tournament-wide
        # gate, because ``_load_solver_inputs`` reads the groups and settings of *drawn*
        # events only. Same transaction, same tournament row lock (the order
        # ``request_solve`` requires); a ``None`` return (Redis down) deliberately costs
        # the solve, never the edit.
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
    await db.refresh(event)
    await _reload_reservation_tables(db, event)
    return event, tournament.league_id
