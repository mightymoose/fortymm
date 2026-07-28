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
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import PoolId
from app.models import (
    DrawType,
    ScheduleSolveTrigger,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    User,
)
from app.schedule_solves import request_solve
from app.schemas.tournament import (
    MatchSettings,
    Slot,
    TournamentEventCreate,
    TournamentEventUpdate,
    named_list,
)
from app.tournament_draws import event_has_draw, event_pools
from app.tournament_edit import _load_owned_tournament_for_update
from app.tournament_errors import (
    DrawTypeFrozenError,
    EventNotFoundError,
    PoolSetFrozenError,
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
    value-objects (``slot``, ``match_settings``, ``predicates``, ``pools``) persist as
    plain JSONB via ``model_dump``. Commits and refreshes before returning. Never
    raises ``HTTPException`` — the caller adapts each domain exception to its
    transport and shapes the read (a just-created event has no entrants, draw or
    results, so those are all empty without a query).

    The tournament's ``league_id`` — already in hand from the owner-load — is returned
    beside the event so the adapter can shape the caller's ``entry_state`` (the ladder
    it is judged on, ADR-0783) without re-querying the column the verb just loaded.
    """
    tournament = await _load_owned_tournament_for_update(db, tournament_id, actor)
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
        # the draw type beside it (ADR 20260727), so what is written here is a pair
        # the settings table's ``CHECK`` will accept.
        draw_settings=TournamentEventDrawSettings.for_draw_type(
            payload.draw_settings.draw_type,
            qualifiers_per_pool=payload.draw_settings.qualifiers_per_pool,
        ),
        max_players=payload.max_players,
        entry_fee=payload.entry_fee,
        timezone=payload.timezone,
        slot=payload.slot.model_dump(),
        match_settings=payload.match_settings.model_dump(),
        predicates=[p.model_dump() for p in payload.predicates],
        pools=[p.model_dump() for p in payload.pools],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event, tournament.league_id


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


def _pool_set_frozen_detail(removed: list[str], added: list[str]) -> str:
    """The 409 sentence for a pools payload that would change *which pools* a cut event
    has — composed exactly as the router's ``_pool_set_refusal`` used to compose it
    inline, so :class:`PoolSetFrozenError` carries the byte-identical body.

    Both halves are named, because a re-**id**'d pool is exactly one removal plus one
    addition and the director has to be told which of their pools went missing: a
    **removed** pool leaves its fixtures pointing at a pool that no longer exists (the
    dangling ref no foreign key is there to catch, ADR-0786), and an **added** pool
    arrives with **no fixtures**, because the draw was dealt across the pools the event
    had at the cut. The sentence ends with the way out (remove the draw, change the
    pools, cut again) and with what is still allowed, so a director who has to move a
    broken table is never left with nowhere to go.
    """
    clauses = []
    if removed:
        clauses.append(
            f"{named_list(removed)} already has fixtures drawn into it, "
            "which this change would leave pointing at a pool that no longer exists"
        )
    if added:
        clauses.append(
            f"{named_list(added)} would arrive with no fixtures in it, "
            "because the draw was cut across the pools this event had at the time"
        )
    return (
        "This event's draw is already cut, so its set of pools is frozen: "
        + "; and ".join(clauses)
        + ". A pool's tables, its time and its name can all still be changed. "
        "To add, remove or re-identify a pool, remove the draw first, then cut it "
        "again."
    )


def _draw_type_frozen_detail(current: DrawType) -> str:
    """The 409 sentence for a ``draw_type`` change on an event whose draw is already cut
    — composed exactly as the router's ``_draw_type_refusal`` used to compose it inline,
    so :class:`DrawTypeFrozenError` carries the byte-identical body.

    It says *how* to get unstuck, because the alternative is a stuck director: the
    draw type chose the strategy that dealt these fixtures, so an event that is
    ``single-elim`` while holding pooled round-robin fixtures is claiming a shape its
    own draw does not have: the fixtures carry a ``pool_id`` that a bracket has no
    pools to name. The refusal names the way out — remove the draw, then re-cut, and
    the new strategy deals fixtures that match the type.
    """
    return (
        f"This event's draw is already cut, so its draw type is frozen: its "
        f"fixtures were dealt as a “{current.value}” draw, and changing the type "
        "would leave the event claiming a shape its draw does not have. To change "
        "the draw type, remove the draw first, then cut it again."
    )


def _qualifiers_per_pool_frozen_detail(
    current: DrawType, qualifiers: int | None
) -> str:
    """The 409 sentence for a ``qualifiers_per_pool`` change on an event whose draw is
    already cut — the same freeze as the draw type's, about the other half of the same
    configuration (ADR 20260727).

    It is not hypothetical and it is not cosmetic. The knockout bracket is cut
    **upfront** from ``P × K``, and the qualifiers are seated into predetermined slots
    as each pool finishes: a bracket cut at ``K = 2`` and then advanced at ``K = 3`` has
    three pools' worth of thirds with nowhere to sit — ``advance()`` seats the five it
    finds slots for, raises nothing, and the draw is quietly wrong. So the count is
    frozen exactly as the type is, and the way out is the same one.
    """
    return (
        "This event's draw is already cut, so the number of qualifiers per pool is "
        f"frozen: its knockout bracket was cut for the top {qualifiers} out of each "
        f"pool of a “{current.value}” draw, and changing that count would leave "
        "qualifiers with no slot to be seated into. To change it, remove the draw "
        "first, then cut it again."
    )


async def _enforce_pool_set_frozen(
    db: AsyncSession, event: TournamentEvent, updates: TournamentEventUpdate
) -> None:
    """Raise :class:`PoolSetFrozenError` once a ``pools`` payload would change *which
    pools* an event with a cut draw has (ADR-0786).

    A fixture names its pool by a **string ref** into this same event's ``pools`` JSONB,
    and there is no pools table for it to foreign-key. So the database cannot refuse the
    edit that orphans it, and the integrity of that reference is procedural — it is this
    function, and nothing else. Remove a pool (or change its ``id``, which is a removal
    with an addition standing where it was) and every fixture drawn into it refers to
    nothing; add one and it arrives with no fixtures, because the draw was dealt across
    the pools that existed at the cut.

    What is frozen is the **id set**, and only the id set. A pool's ``table_ids``, its
    ``slot`` and its ``name`` stay editable with a draw standing, on purpose — this is
    the case the freeze exists to *permit*, not to prevent.

    Asked **before** anything is written (and, like every judge-then-write guard, under
    the tournament's row lock the verb holds), so a refusal leaves both the pools and
    the fixtures exactly as they were — never written, not merely rolled back. With
    **no draw cut** this is a no-op and ``pools`` replaces wholesale, as it always has.
    """
    # An absent ``pools`` key is the only way this is ``None`` — an explicit ``null`` is
    # a 422 at the schema (the column is NOT NULL) — so "not sent" is the whole meaning
    # of it, and an event whose pools are not being replaced has nothing to enforce.
    if updates.pools is None:
        return
    # The freeze turns on the draw EXISTING, not on it having been played: an unplayed
    # draw is the ordinary state of a tournament that has not started, and it is just as
    # orphanable as a played one.
    if not await event_has_draw(db, event.id):
        return
    # Parsed ONCE, and kept: the id set decides *whether* to refuse, and the pools
    # themselves say *which* — a refusal names them (``named_list``), and re-parsing the
    # JSONB to recover the names would be the same validation run twice per pool.
    current = event_pools(event)
    existing = {PoolId(pool.id) for pool in current}
    incoming = {PoolId(pool.id) for pool in updates.pools}
    if existing == incoming:
        return
    # Named by their names, from whichever side of the change still knows them: a pool
    # being removed is only described by the row we hold, and one being added only by
    # the payload.
    removed = [pool.name for pool in current if PoolId(pool.id) not in incoming]
    added = [pool.name for pool in updates.pools if pool.id not in existing]
    raise PoolSetFrozenError(
        _pool_set_frozen_detail(removed, added), removed=removed, added=added
    )


async def _enforce_draw_settings_frozen(
    db: AsyncSession, event: TournamentEvent, updates: TournamentEventUpdate
) -> None:
    """Raise :class:`DrawTypeFrozenError` once a draw-configuration payload would change
    the **draw type or its qualifier count** on an event that **has a draw** (ADR-0786,
    ADR 20260727).

    A draw type is not a label on an event — it is the strategy that dealt the event's
    fixtures, and the fixtures are the shape that strategy prescribes. Patch it under a
    standing draw and the two facts contradict each other. The go-live currency check
    cannot catch it (currency compares the seated entrant set against the active
    entrants, and re-labelling moves neither), which is why this guard has to exist.

    ``qualifiers_per_pool`` is frozen by the **same** guard rather than a parallel one,
    because it is the same fact wearing a second column: an ``rr-then-ko`` draw's
    bracket is cut upfront for ``P × K``, so a K the fixtures were not cut for is
    exactly as contradictory as a type they were not dealt by — and quieter (see
    :func:`_qualifiers_per_pool_frozen_detail`). One comparison over the whole
    configuration is also what keeps a payload that moves *both* from being judged
    twice.

    **Presence is not enough — the change is what is refused.** A configuration equal to
    the one the event already has changes nothing, so a page PATCHing the whole event
    form back (draw type and count included) to move a pool's tables is the very edit
    the freeze exists to permit. Asked **before** anything is written, under the
    tournament's row lock the verb holds.

    What the event *currently* has is read off its ``draw_settings`` row — the one home
    of that fact (ADR "an event's draw configuration is a row, not a column") — and read
    once, before the caller's ``setattr`` loop, so what is compared is the stored
    configuration and not the one the payload is asking for.
    """
    # ``None`` is "this patch does not touch the draw configuration": the schema refuses
    # an explicit ``null`` on ``draw_type`` (422) and refuses a ``qualifiers_per_pool``
    # with no ``draw_type`` beside it, so an absent draw type means an absent pair.
    incoming = updates.draw_settings
    if incoming is None:
        return
    current = event.draw_settings.draw_type
    current_qualifiers = event.draw_settings.qualifiers_per_pool
    if (
        incoming.draw_type is current
        and incoming.qualifiers_per_pool == current_qualifiers
    ):
        return
    # Only now the query — and only for a payload that really moves the configuration.
    # It is the same ``event_has_draw`` the pool freeze asks; a payload that changes
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
        else _qualifiers_per_pool_frozen_detail(current, current_qualifiers)
    )
    raise DrawTypeFrozenError(detail, draw_type=current.value)


def _event_scheduling_facts(
    event: TournamentEvent,
) -> tuple[tuple[tuple[str, Slot, tuple[str, ...]], ...], int, str]:
    """The slice of an event the schedule solver actually reads (ADR "the schedule is
    solved; the call is pinned"), in a comparable shape — what the update verb compares
    before/after its write to decide whether a re-solve is owed.

    Exactly three facts feed ``_load_solver_inputs``: each pool's identity, window and
    tables (its *name* is display and deliberately absent — a pool rename must not spend
    a solve), ``match_settings.length_games`` (duration input; ``rated`` is a results
    rule the solver never sees), and the event ``timezone`` — the anchor that turns each
    Slot's wall-clock ``{date,start,end}`` into the real instant the solver compares
    against ``now``. Without the timezone here a tz-only correction re-anchors every
    placement but compares equal, so a stale ``infeasible``/``past_window`` verdict
    would never be re-solved away. Parsed through the same models the write boundary
    validated the JSONB with (parse, don't validate), and read off the ROW not the
    payload, so "changed" means the row changed — a PATCH that re-sends the values the
    event already holds compares equal and triggers nothing.
    """
    settings = MatchSettings.model_validate(event.match_settings)
    return (
        tuple(
            (pool.id, pool.slot, tuple(pool.table_ids)) for pool in event_pools(event)
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
    by the offset delta while its local reading stays put. The pool ``Slot`` windows get
    this for free (wall-clock ``{date,start,end}`` components, untouched by the edit);
    ``scheduled_start`` is a ``timestamptz`` **instant**, so it is recomposed here or it
    would silently shift.

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

    placed = (
        (
            await db.execute(
                select(TournamentFixture).where(
                    TournamentFixture.event_id == event_id,
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
    * **409** — once the event's draw is cut, two things freeze (ADR-0786): a ``pools``
      payload that changes *which pools* the event has raises
      :class:`PoolSetFrozenError`, and a draw-configuration payload that changes the
      draw type **or its qualifier count** (ADR 20260727) raises
      :class:`DrawTypeFrozenError`. Both are judged **before** anything is
      written, so a refusal persists nothing.

    Then the partial apply (``model_dump(exclude_unset=True)`` serializes the nested
    value-objects to plain dicts/lists, so one ``setattr`` loop covers the JSONB and
    scalar columns alike), with three side effects — the first new, the other two
    preserved exactly from the router:

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
    await _enforce_pool_set_frozen(db, event, updates)
    await _enforce_draw_settings_frozen(db, event, updates)
    facts_before = _event_scheduling_facts(event)
    # Captured BEFORE the setattr loop overwrites it: a timezone edit preserves the
    # wall-clock of already-placed fixtures, which needs the zone they were placed IN to
    # recover it.
    old_timezone = event.timezone
    changes = updates.model_dump(exclude_unset=True)
    # Neither half of the draw configuration is a column on the event — the draw type is
    # the ``draw_type_key`` slug on the settings row the event points at, and the
    # qualifier count is that row's ``qualifiers_per_pool`` — so both are routed OUT of
    # the generic setattr loop rather than through it. This is not decoration:
    # SQLAlchemy's declarative instances accept any attribute, so
    # ``setattr(event, "draw_type", ...)`` would bind a plain Python attribute the
    # mapper
    # never persists — the edit would be silently accepted and silently dropped. Popping
    # them leaves the loop below touching mapped columns only.
    changes.pop("draw_type", None)
    changes.pop("qualifiers_per_pool", None)
    # The parsed union arm, not the loose keys: it is ``None`` exactly when the patch
    # does not touch the draw configuration, and when it is not, the pair it carries is
    # one the settings table's ``CHECK`` accepts (ADR 20260727).
    draw_settings = updates.draw_settings
    for key, value in changes.items():
        setattr(event, key, value)
    if draw_settings is not None:
        # The one place an event's draw configuration moves after create (the freeze
        # above has already refused this on a cut draw). Assigned through the settings
        # row's ``configure``, not its columns, so the enum→slug conversion and the
        # "these two columns are one fact" pairing stay in the single place that owns
        # them — the same door ``for_draw_type`` goes through at create. The settings
        # row
        # is loaded with the event (``lazy="joined"``), so this is a plain attribute
        # write, not a lazy load in async context.
        event.draw_settings.configure(
            draw_settings.draw_type,
            qualifiers_per_pool=draw_settings.qualifiers_per_pool,
        )
    if event.timezone != old_timezone:
        # The zone truly moved (a PATCH re-sending the same zone falls through as a
        # no-op): recompose every placement so its local reading is unchanged and only
        # its stored instant shifts by the offset delta. The Slot windows stay put.
        await _reanchor_placements_for_timezone_change(
            db, event.id, old_timezone=old_timezone, new_timezone=event.timezone
        )
    if facts_before != _event_scheduling_facts(event) and await event_has_draw(
        db, event.id
    ):
        # Gated on THIS event having a cut draw — stricter than the tournament-wide
        # gate, because ``_load_solver_inputs`` reads the pools and settings of *drawn*
        # events only. Same transaction, same tournament row lock (the order
        # ``request_solve`` requires); a ``None`` return (Redis down) deliberately costs
        # the solve, never the edit.
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
    await db.refresh(event)
    return event, tournament.league_id
