"""Service-layer tests for the transport-neutral cut / un-cut draw verbs.

These drive ``app.tournament_draw_service.cut_event_draw`` /
``uncut_event_draw`` directly with a raw ``db_session`` and no FastAPI — proving
the write path (row-locked owner gate, event-under-tournament load, play-evidence
gate, the ``cut_draw`` / ``uncut_draw`` core) runs, persists, and signals every
refusal with a **domain exception** from ``app.tournament_errors`` (or lets the
``app.draws.DrawError`` family propagate unchanged) rather than an
``HTTPException``. The HTTP wire contract those exceptions map back to is pinned
by the unchanged endpoint tests in ``test_tournaments.py`` (``-k draw``); this
file is the branch matrix behind them.
"""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import NonSinglesDraw
from app.models import (
    League,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.tournament import DrawType, EventFormat
from app.tournament_draw_service import cut_event_draw, uncut_event_draw
from app.tournament_errors import (
    DrawUnderWayError,
    EventNotFoundError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)
from app.tournament_event_stages import mint_stages
from app.tournament_queries import stage_ids_for_events
from tests._entry_seeds import entry_with_members
from tests._helpers import (
    event_groups,
    make_user,
    venue_tables,
)

# Two groups, so the snake has somewhere to snake to and a fixture's ``group_id`` is
# a ref that resolves against the right one — the same shape ``test_tournaments.py``'s
# draw tests cut across.
RESERVATION_A: dict[str, object] = {
    "name": "Reservation A",
    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
    "table_ids": ["t1"],
}
RESERVATION_B: dict[str, object] = {
    "name": "Reservation B",
    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
    "table_ids": ["t2"],
}


async def _make_tournament(
    db: AsyncSession,
    *,
    owner: User,
    league: League,
) -> Tournament:
    tournament = Tournament(
        name="Bay Area Open 2026",
        description="Two-day open.",
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(("Table 1", "A"), ("Table 2", "A")),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.draft,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def _make_event(
    db: AsyncSession,
    tournament: Tournament,
    *,
    format: EventFormat = EventFormat.singles,
    draw_type: DrawType = DrawType.round_robin,
    groups: list[dict[str, object]] | None = None,
) -> TournamentEvent:
    stages = mint_stages(draw_type)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=format,
        draw_settings=TournamentEventDrawSettings.for_draw_type(draw_type),
        max_players=64,
        entry_fee=Decimal("45"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        stages=stages,
    )
    reservations = [RESERVATION_A, RESERVATION_B] if groups is None else groups
    stages[0].groups = event_groups(
        reservations,
        event=event,
        tournament=tournament,
        # This file's tests deliberately seed a group per reservation, whatever the
        # draw type — a raw ORM state #1484's floor no longer produces through any
        # real route, but one several tests here still want directly (a multi-group
        # cut). ``max(..., 1)`` is #1484's own floor, not this file's license: every
        # stage holds at least one group now, so a caller passing ``groups=[]`` (no
        # reservations) still gets the one group its stage requires, mapped to no
        # reservation — never the zero-group, ``group_id IS NULL`` state #1484
        # makes unrepresentable.
        group_count=max(len(reservations), 1),
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


async def _enter_field(
    db: AsyncSession, event: TournamentEvent, count: int, *, prefix: str
) -> list[TournamentEntry]:
    """``count`` active, seeded (1..N) entrants — enough for the round-robin snake to
    deal a clean draw across the two groups."""
    entries = [
        entry_with_members(
            db,
            event,
            (await make_user(db, f"{prefix}{n}")).player_id,
            status=TournamentEntryStatus.entered,
            seed=n,
        )
        for n in range(1, count + 1)
    ]
    db.add_all(entries)
    await db.commit()
    return entries


async def _fixture_rows(
    db: AsyncSession, event_id: uuid.UUID
) -> list[TournamentFixture]:
    db.expire_all()
    return list(
        (
            await db.execute(
                select(TournamentFixture).where(
                    TournamentFixture.stage_id.in_(stage_ids_for_events([event_id]))
                )
            )
        )
        .scalars()
        .all()
    )


# ----- the owner cuts a singles event: fixtures are created + persisted ------


async def test_owner_cut_creates_and_persists_fixtures(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-cut")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    # Capture PKs before the verb commits — the commit expires the ORM objects, so
    # reading their ids afterwards would trigger a sync lazy-load in async land.
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="cut")
    await db_session.refresh(owner)

    result = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    # Four singles over two groups: 2 apiece, one round-robin fixture in each group.
    assert len(result) == 2
    rows = await _fixture_rows(db_session, event_id)
    # The verb answers with the persisted draw — same rows, same ids.
    assert {f.id for f in result} == {r.id for r in rows}
    # Every fixture seats two known entrants, none played.
    assert all(
        r.entry_a_id is not None
        and r.entry_b_id is not None
        and r.winner_entry_id is None
        and r.match_id is None
        for r in rows
    )


# ----- the owner cuts a single-elim event: an ungrouped bracket is persisted -


async def test_owner_cut_of_a_single_elim_event_persists_the_bracket(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The second implemented draw type (ADR-0785): cutting a single-elim event no
    longer raises ``UnsupportedDrawType`` — it persists a seeded bracket. Its one
    stage holds its one group (#1484's floor), which every fixture names — mapped
    to no reservation here — and unlike a round-robin cut the later rounds are TBD
    (``NULL`` sides), filled by ``advance()`` as results land."""
    owner = await make_user(db_session, "owner-se-cut")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # A single-elim event holds exactly one group, mapped to no reservation; the
    # strategy ignores ``group_ids`` regardless, deferring to ``_sole_group``.
    event = await _make_event(
        db_session, tournament, draw_type=DrawType.single_elim, groups=[]
    )
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 5, prefix="se")
    await db_session.refresh(owner)

    result = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    # 5 entrants → an 8-slot bracket: 1 round-1 match, 2 semifinals, 1 final = 4 rows
    # (ADR-0786's "a 5-entrant single-elim persists 4 rows").
    assert len(result) == 4
    rows = await _fixture_rows(db_session, event_id)
    assert {f.id for f in result} == {r.id for r in rows}
    # One group, shared by every fixture; one fixture in the final round, and
    # nothing played yet.
    (group_id,) = {r.group_id for r in rows}
    assert group_id is not None
    assert sorted(r.round for r in rows) == [1, 2, 2, 3]
    assert all(r.winner_entry_id is None and r.match_id is None for r in rows)
    # Byes are absence and later rounds are TBD: unlike round-robin, not every fixture
    # seats two known entrants at the cut.
    assert any(r.entry_a_id is None or r.entry_b_id is None for r in rows)


# ----- a re-cut on a drawn-but-unplayed event replaces wholesale -------------


async def test_recut_of_an_unplayed_draw_replaces_wholesale(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-recut")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="recut")

    await db_session.refresh(owner)
    first = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    first_ids = {f.id for f in first}

    await db_session.refresh(owner)
    second = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    second_ids = {f.id for f in second}

    # Wholesale, not a reconcile: the old rows were deleted and a fresh set minted,
    # so no id survives, and the event holds exactly the second draw.
    assert first_ids.isdisjoint(second_ids)
    rows = await _fixture_rows(db_session, event_id)
    assert {r.id for r in rows} == second_ids
    retained_ids = set(
        (
            await db_session.execute(
                text(
                    "SELECT id FROM tournament_fixtures WHERE scope_event_id = "
                    ":event_id"
                ),
                {"event_id": event_id},
            )
        ).scalars()
    )
    assert retained_ids == first_ids | second_ids


# ----- evidence of play refuses both a re-cut and an un-cut ------------------


@pytest.mark.parametrize("verb", [cut_event_draw, uncut_event_draw])
async def test_a_played_draw_refuses_recut_and_uncut(
    db_session: AsyncSession,
    default_league: League,
    verb: object,
) -> None:
    owner = await make_user(db_session, "owner-played")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="played")

    await db_session.refresh(owner)
    await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    # Record a winner on one fixture — evidence of play (``draw_has_play``): a re-cut
    # or an un-cut would throw away a result a player produced.
    rows = await _fixture_rows(db_session, event_id)
    rows[0].winner_entry_id = rows[0].entry_a_id
    await db_session.commit()
    before = {r.id for r in await _fixture_rows(db_session, event_id)}

    await db_session.refresh(owner)
    with pytest.raises(DrawUnderWayError):
        await verb(  # type: ignore[operator]  # parametrized over the two verbs
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )

    # The refusal is asked before anything is deleted, so the standing draw is intact.
    assert {r.id for r in await _fixture_rows(db_session, event_id)} == before


# ----- an event that cannot produce a draw raises the DrawError family -------


async def test_a_non_singles_event_raises_non_singles_draw(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-doubles")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, format=EventFormat.doubles)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="doubles")

    await db_session.refresh(owner)
    with pytest.raises(NonSinglesDraw):
        await cut_event_draw(
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )

    # Refused before the DELETE, so nothing was written.
    assert await _fixture_rows(db_session, event_id) == []


# ``test_an_unimplemented_draw_type_raises_unsupported_draw_type`` lived here. Its only
# subject was an ``rr-then-ko`` event, which is no longer a ``DrawType`` member (ADR "a
# draw type is a seeded row, and the enum holds only what runs"): every draw type this
# verb can be handed now has a strategy, so ``cut_event_draw`` has no ``draw_type`` that
# raises ``UnsupportedDrawType`` to re-point it at. The claim it protected — an
# unimplemented draw type is refused — moved to the request boundary and is asserted
# in ``test_tournaments`` (create-event 422) and in ``test_draws`` (``strategy_for``
# is total).


# ----- un-cut removes the fixtures -------------------------------------------


async def test_uncut_removes_the_fixtures(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-uncut")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="uncut")

    await db_session.refresh(owner)
    await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    assert await _fixture_rows(db_session, event_id) != []

    await db_session.refresh(owner)
    result = await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    assert result is None
    assert await _fixture_rows(db_session, event_id) == []


async def test_uncut_of_a_never_cut_draw_is_a_no_op(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An event with no draw is already in the state the un-cut asks for — deleting
    nothing is a success, not a 404 (the router answers 204 either way)."""
    owner = await make_user(db_session, "owner-idem")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id

    result = await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    assert result is None
    assert await _fixture_rows(db_session, event_id) == []


# ----- a non-owner is refused with a domain exception -----------------------


@pytest.mark.parametrize("verb", [cut_event_draw, uncut_event_draw])
async def test_a_non_owner_is_refused(
    db_session: AsyncSession,
    default_league: League,
    verb: object,
) -> None:
    owner = await make_user(db_session, "owner-guard")
    stranger = await make_user(db_session, "stranger-guard")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="guard")

    with pytest.raises(NotTournamentOwnerError):
        await verb(  # type: ignore[operator]  # parametrized over the two verbs
            db_session,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=stranger,
        )

    # The ownership gate is asked before the draw's own state, so nothing changed.
    assert await _fixture_rows(db_session, event_id) == []


# ----- a missing tournament / event raises the 404-domain exception ---------


async def test_a_missing_tournament_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-missing-t")

    with pytest.raises(TournamentNotFoundError):
        await cut_event_draw(
            db_session,
            tournament_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            actor=owner,
        )


async def test_a_missing_event_raises_event_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-missing-e")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    await db_session.refresh(owner)

    with pytest.raises(EventNotFoundError):
        await cut_event_draw(
            db_session,
            tournament_id=tournament_id,
            event_id=uuid.uuid4(),
            actor=owner,
        )


async def test_an_event_under_the_wrong_tournament_raises_event_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A right event id under the wrong tournament id is a miss, not a
    cross-tournament draw — the event is scoped by both ids."""
    owner = await make_user(db_session, "owner-cross")
    other_owner = await make_user(db_session, "owner-cross-other")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    other = await _make_tournament(db_session, owner=other_owner, league=default_league)
    event = await _make_event(db_session, other)
    event_id = event.id
    await db_session.refresh(owner)

    with pytest.raises(EventNotFoundError):
        await cut_event_draw(
            db_session,
            tournament_id=tournament_id,
            event_id=event_id,
            actor=owner,
        )


async def test_cut_records_participation_and_withdrawal_ends_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    from app.tournament_entries import withdraw_from_event

    owner = await make_user(db_session, "owner-periods")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament.status = TournamentStatus.published
    await db_session.commit()
    event = await _make_event(db_session, tournament)
    tournament_id, event_id, owner_id = tournament.id, event.id, owner.id
    await _enter_field(db_session, event, 4, prefix="periods")
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    entry_id = fixtures[0].entry_a_id
    assert entry_id is not None
    await db_session.refresh(owner)
    await withdraw_from_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        entry_id=entry_id,
        actor=owner,
    )
    period = (
        await db_session.execute(
            text(
                "SELECT ended_at, ended_by_account_id, end_reason FROM "
                "tournament_entry_participations WHERE entry_id = :entry_id"
            ),
            {"entry_id": entry_id},
        )
    ).one()
    assert period.ended_at is not None
    assert period.ended_by_account_id == owner_id
    assert period.end_reason == "director_removal"


async def test_fixture_keeps_specific_participation_when_draw_is_replaced(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-links")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="links")
    await db_session.refresh(owner)
    first = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    fixture_id = first[0].id
    await db_session.refresh(owner)
    await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    row = (
        await db_session.execute(
            text(
                "SELECT p.entry_id, p.ended_at, p.end_reason, f.entry_a_id "
                "FROM tournament_fixtures f JOIN tournament_entry_participations p "
                "ON p.id = f.participation_a_id WHERE f.id = :fixture_id"
            ),
            {"fixture_id": fixture_id},
        )
    ).one()
    assert row.entry_id == row.entry_a_id
    assert row.ended_at is not None
    assert row.end_reason == "draw_retired"


async def test_recut_has_one_current_event_wide_revision(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-revisions")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="revisions")
    for _ in range(2):
        await db_session.refresh(owner)
        await cut_event_draw(
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )
    revisions = (
        await db_session.execute(
            text(
                "SELECT r.id, r.retired_at, count(f.id) AS fixtures FROM "
                "tournament_draw_revisions r "
                "JOIN tournament_fixtures f ON f.draw_revision_id = r.id "
                "WHERE r.event_id = :event_id GROUP BY r.id ORDER BY r.created_at"
            ),
            {"event_id": event_id},
        )
    ).all()
    assert len(revisions) == 2
    assert revisions[0].retired_at is not None
    assert revisions[1].retired_at is None
    assert [row.fixtures for row in revisions] == [2, 2]


async def test_reregistering_same_entry_does_not_restore_draw_currency(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    from app.tournament_draws import DrawCurrency, draw_currency_by_event
    from app.tournament_entries import enter_event, withdraw_from_event

    owner = await make_user(db_session, "owner-currency-period")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament.status = TournamentStatus.published
    await db_session.commit()
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="currency-period")
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    entry_id = fixtures[0].entry_a_id
    entry = await db_session.get(TournamentEntry, entry_id)
    assert entry is not None
    player_id = entry.user_id
    await db_session.refresh(owner)
    await withdraw_from_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        entry_id=entry.id,
        actor=owner,
    )
    await db_session.refresh(owner)
    registered = await enter_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        user_id=player_id,
    )
    assert registered.id == entry_id
    assert (await draw_currency_by_event(db_session, [event_id]))[
        event_id
    ] is DrawCurrency.stale


async def test_withdrawn_entry_cannot_gain_active_participation_by_sql(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    from sqlalchemy.exc import IntegrityError

    from app.tournament_entries import withdraw_from_event

    owner = await make_user(db_session, "owner-no-admission")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament.status = TournamentStatus.published
    await db_session.commit()
    event = await _make_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="no-admission")
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    entry_id = fixtures[0].entry_a_id
    assert entry_id is not None
    await db_session.refresh(owner)
    await withdraw_from_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        entry_id=entry_id,
        actor=owner,
    )
    with pytest.raises(IntegrityError):
        await db_session.execute(
            text(
                "INSERT INTO "
                "tournament_entry_participations(event_id,entry_id,stage_id,group"
                "_id) "
                "SELECT event_id,entry_id,stage_id,group_id FROM "
                "tournament_entry_participations "
                "WHERE entry_id = :entry_id LIMIT 1"
            ),
            {"entry_id": entry_id},
        )
        await db_session.commit()
    await db_session.rollback()


async def test_swiss_bye_has_stage_participation_without_a_fixture(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-bye-period")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(
        db_session, tournament, draw_type=DrawType.swiss, groups=[]
    )
    event.draw_settings = TournamentEventDrawSettings.for_draw_type(
        DrawType.swiss, settings={"rounds": 3}
    )
    await db_session.commit()
    tournament_id, event_id = tournament.id, event.id
    entries = await _enter_field(db_session, event, 3, prefix="bye-period")
    expected_ids = {entry.id for entry in entries}
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    assert sum(f.entry_a_id is not None for f in fixtures) == 1
    admitted = set(
        (
            await db_session.execute(
                text(
                    "SELECT entry_id FROM tournament_entry_participations "
                    "WHERE event_id = :event_id AND ended_at IS NULL"
                ),
                {"event_id": event_id},
            )
        ).scalars()
    )
    assert admitted == expected_ids


async def test_swiss_bye_reregistration_still_requires_a_recut(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    from app.tournament_draws import DrawCurrency, draw_currency_by_event
    from app.tournament_entries import enter_event, withdraw_from_event

    owner = await make_user(db_session, "owner-bye-currency")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament.status = TournamentStatus.published
    await db_session.commit()
    event = await _make_event(
        db_session, tournament, draw_type=DrawType.swiss, groups=[]
    )
    event.draw_settings = TournamentEventDrawSettings.for_draw_type(
        DrawType.swiss, settings={"rounds": 3}
    )
    await db_session.commit()
    tournament_id, event_id = tournament.id, event.id
    entries = await _enter_field(db_session, event, 3, prefix="bye-currency")
    entry_players = {entry.id: entry.user_id for entry in entries}
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    seated = {
        entry_id
        for f in fixtures
        for entry_id in (f.entry_a_id, f.entry_b_id)
        if entry_id is not None
    }
    bye_id = next(entry_id for entry_id in entry_players if entry_id not in seated)
    await db_session.refresh(owner)
    await withdraw_from_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        entry_id=bye_id,
        actor=owner,
    )
    await db_session.refresh(owner)
    registered = await enter_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        user_id=entry_players[bye_id],
    )
    assert registered.id == bye_id
    assert (await draw_currency_by_event(db_session, [event_id]))[
        event_id
    ] is DrawCurrency.stale


@pytest.mark.parametrize("event_wide", [True, False])
async def test_competition_withdrawal_scope_controls_recut_field(
    db_session: AsyncSession, default_league: League, event_wide: bool
) -> None:
    from app.tournament_draws import (
        DrawCurrency,
        active_draw_entrants_by_event,
        draw_currency_by_event,
    )
    from app.tournament_participation import (
        WithdrawalReason,
        restore_event_eligibility,
        withdraw_competition,
    )

    owner = await make_user(db_session, "competition-withdrawal-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    entries = await _enter_field(db_session, event, 3, prefix="competition-field")
    entry_ids = {entry.id for entry in entries}
    withdrawn_id = entries[0].id
    tournament_id, event_id, owner_id = tournament.id, event.id, owner.id
    initial = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await withdraw_competition(
        db_session,
        withdrawn_id,
        owner_id,
        WithdrawalReason.director_removal,
        stage_id=None if event_wide else initial[0].stage_id,
    )
    await db_session.commit()
    await db_session.refresh(owner)

    recut = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )

    expected_field = entry_ids - {withdrawn_id} if event_wide else entry_ids
    assert len(recut) == (1 if event_wide else 3)
    assert {
        entry_id
        for fixture in recut
        for entry_id in (fixture.entry_a_id, fixture.entry_b_id)
    } == expected_field
    assert {
        entrant.entry_id
        for entrant in (await active_draw_entrants_by_event(db_session, [event_id]))[
            event_id
        ]
    } == expected_field
    assert (await draw_currency_by_event(db_session, [event_id]))[
        event_id
    ] is DrawCurrency.current
    assert (
        await db_session.scalar(
            select(TournamentEntry.status).where(TournamentEntry.id == withdrawn_id)
        )
        is TournamentEntryStatus.entered
    )

    await restore_event_eligibility(db_session, withdrawn_id, owner_id)
    await db_session.commit()
    await db_session.refresh(owner)
    restored = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    assert len(restored) == 3


async def test_materialization_uses_rules_at_cut_after_planning_values_change(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.models import Match
    from app.tournament_materialization import materialize_event

    owner = await make_user(db_session, "rules-materialize-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    event = (
        await db_session.scalars(
            select(TournamentEvent).where(TournamentEvent.id == eid)
        )
    ).one()
    tournament = (
        await db_session.scalars(select(Tournament).where(Tournament.id == tid))
    ).one()
    event.match_settings = {"rated": False, "length_games": 1}
    await db_session.flush()
    await materialize_event(db_session, tournament, event)
    await db_session.flush()
    matches = (await db_session.scalars(select(Match))).all()
    assert matches
    for match in matches:
        await db_session.refresh(match, attribute_names=["match_settings"])
        assert match.match_settings.best_of == 5
        assert match.match_settings.affects_rating is True


async def test_sql_cannot_rewrite_frozen_competition_rules(
    db_session: AsyncSession, default_league: League
) -> None:
    from sqlalchemy.exc import IntegrityError

    owner = await make_user(db_session, "rules-integrity-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-integrity-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    with pytest.raises(IntegrityError, match="immutable"):
        await db_session.execute(
            text(
                "UPDATE tournament_draw_revisions SET match_rules = "
                "jsonb_set(match_rules, '{best_of}', '1') WHERE event_id=:id"
            ),
            {"id": eid},
        )


async def test_cut_draw_keeps_format_interpretation_after_planning_change(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.tournament_serialization import event_results

    owner = await make_user(db_session, "rules-format-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-format-field")
    await db_session.refresh(owner)
    fixtures = await cut_event_draw(
        db_session, tournament_id=tid, event_id=eid, actor=owner
    )
    event = (
        await db_session.scalars(
            select(TournamentEvent).where(TournamentEvent.id == eid)
        )
    ).one()
    event.draw_settings = TournamentEventDrawSettings.for_draw_type(
        DrawType.single_elim
    )
    result = event_results(
        event,
        entrants=[],
        fixtures=fixtures,
        game_counts={},
        stage_draw_types={stage.id: stage.draw_type for stage in event.stages},
    )
    assert result is not None
    assert result.kind == "standings"


async def test_every_stage_and_materialized_match_references_its_draw_rules(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.tournament_materialization import materialize_event

    owner = await make_user(db_session, "rules-provenance-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-provenance-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    event = (
        await db_session.scalars(
            select(TournamentEvent).where(TournamentEvent.id == eid)
        )
    ).one()
    tournament = (
        await db_session.scalars(select(Tournament).where(Tournament.id == tid))
    ).one()
    await materialize_event(db_session, tournament, event)
    await db_session.flush()
    rows = (
        await db_session.execute(
            text("""
        SELECT s.rule_revision_id, f.draw_revision_id, ms.source_rule_revision_id
        FROM tournament_fixtures f JOIN tournament_event_stages s ON s.id=f.stage_id
        JOIN matches m ON m.id=f.match_id
        JOIN match_settings ms ON ms.id=m.match_settings_id
        WHERE s.event_id=:id
    """),
            {"id": eid},
        )
    ).all()
    assert rows
    assert all(stage == fixture == match for stage, fixture, match in rows)


async def test_sql_cannot_detach_stage_from_frozen_rules(
    db_session: AsyncSession, default_league: League
) -> None:
    from sqlalchemy.exc import IntegrityError

    owner = await make_user(db_session, "rules-stage-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-stage-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    with pytest.raises(IntegrityError, match="immutable"):
        await db_session.execute(
            text(
                "UPDATE tournament_event_stages SET rule_revision_id=NULL WHERE "
                "event_id=:id"
            ),
            {"id": eid},
        )


async def test_sql_cannot_claim_rule_provenance_for_different_match_values(
    db_session: AsyncSession, default_league: League
) -> None:
    from sqlalchemy.exc import IntegrityError

    from app.models import MatchSettings

    owner = await make_user(db_session, "rules-forged-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-forged-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    revision_id = await db_session.scalar(
        text(
            "SELECT id FROM tournament_draw_revisions WHERE event_id=:id AND "
            "retired_at IS NULL"
        ),
        {"id": eid},
    )
    db_session.add(
        MatchSettings(team_size=1, best_of=1, source_rule_revision_id=revision_id)
    )
    with pytest.raises(IntegrityError, match="match rules must agree"):
        await db_session.flush()


async def test_attached_standalone_match_must_obey_frozen_competition_rules(
    db_session: AsyncSession, default_league: League
) -> None:
    from sqlalchemy.exc import IntegrityError

    from app.models import Match, MatchSettings
    from tests._entry_seeds import seed_fixture_match_sides

    owner = await make_user(db_session, "rules-attach-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid, oid, lid = tournament.id, event.id, owner.id, default_league.id
    await _enter_field(db_session, event, 4, prefix="rules-attach-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    fixture = (await _fixture_rows(db_session, eid))[0]
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=1),
        league_id=lid,
        created_by_user_id=oid,
    )
    db_session.add(match)
    await db_session.flush()
    await seed_fixture_match_sides(db_session, fixture, match)
    fixture.match_id = match.id
    with pytest.raises(IntegrityError, match="fixture match rules"):
        await db_session.flush()


@pytest.mark.parametrize(
    "column,payload",
    [
        ("match_rules", "{}"),
        ("match_rules", "[]"),
        (
            "match_rules",
            '{"rule_version":1,"team_size":1,"best_of":9,'
            '"affects_rating":true,"verification_policy":"none",'
            '"retirement_window":"P7D"}',
        ),
        (
            "match_rules",
            '{"rule_version":1,"team_size":1,"best_of":3,'
            '"affects_rating":true,"verification_policy":"none",'
            '"retirement_window":"7 days"}',
        ),
        ("format_rules", '{"version":1,"draw_type":"swiss","settings":{"rounds":"2"}}'),
        ("format_rules", '{"version":1,"draw_type":"swiss","settings":{"rounds":33}}'),
        ("format_rules", "{}"),
        ("format_rules", '{"version": 99, "draw_type":"round-robin", "settings":{}}'),
    ],
)
async def test_sql_refuses_uninterpretable_rule_revisions(
    db_session: AsyncSession, default_league: League, column: str, payload: str
) -> None:
    from sqlalchemy.exc import IntegrityError

    owner = await make_user(db_session, "rules-malformed-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    with pytest.raises(IntegrityError, match="rule"):
        await db_session.execute(
            text(
                f"INSERT INTO tournament_draw_revisions(event_id, {column}) "
                "VALUES (:id, CAST(:payload AS jsonb))"
            ),
            {"id": event.id, "payload": payload},
        )


async def test_sql_draw_creation_binds_all_current_stages_atomically(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "rules-sql-stage-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    revision_id = await db_session.scalar(
        text(
            "INSERT INTO tournament_draw_revisions(event_id) VALUES (:id) RETURNING id"
        ),
        {"id": event.id},
    )
    bindings = (
        await db_session.scalars(
            text(
                "SELECT rule_revision_id FROM tournament_event_stages WHERE "
                "event_id=:id AND retired_at IS NULL"
            ),
            {"id": event.id},
        )
    ).all()
    assert bindings and all(value == revision_id for value in bindings)


async def test_schedule_duration_uses_frozen_match_rules(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.competition_rules import effective_match_settings

    owner = await make_user(db_session, "rules-duration-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-duration-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    event = (
        await db_session.scalars(
            select(TournamentEvent).where(TournamentEvent.id == eid)
        )
    ).one()
    event.match_settings = {"rated": False, "length_games": 1}
    assert effective_match_settings(event).length_games == 5


async def test_sql_fixture_cannot_use_a_stage_without_its_rule_revision(
    db_session: AsyncSession, default_league: League
) -> None:
    from sqlalchemy.exc import IntegrityError

    from app.models import TournamentEventStage, TournamentEventStageGroup

    owner = await make_user(db_session, "rules-stage-scope-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-stage-scope-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    extra_stage = TournamentEventStage(
        event_id=eid, position=1, draw_type=DrawType.round_robin
    )
    extra_group = TournamentEventStageGroup(position=0)
    extra_stage.groups = [extra_group]
    db_session.add(extra_stage)
    await db_session.flush()
    db_session.add(
        TournamentFixture(
            stage_id=extra_stage.id, group_id=extra_group.id, round=1, position=1
        )
    )
    with pytest.raises(IntegrityError, match="fixture stage rules"):
        await db_session.flush()


async def test_recut_keeps_rule_history_until_permitted_event_deletion(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.tournament_events import delete_event

    owner = await make_user(db_session, "rules-retention-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-retention-field")
    await db_session.refresh(owner)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    original = (
        await db_session.execute(
            text(
                "SELECT id, match_rules, format_rules FROM "
                "tournament_draw_revisions WHERE event_id=:id"
            ),
            {"id": eid},
        )
    ).one()
    await uncut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    await db_session.refresh(event)
    assert event.current_rule_revision is None
    assert all(stage.rule_revision_id is None for stage in event.stages)
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    revisions = (
        await db_session.execute(
            text(
                "SELECT id, match_rules, format_rules FROM "
                "tournament_draw_revisions WHERE event_id=:id ORDER BY created_at"
            ),
            {"id": eid},
        )
    ).all()
    assert len(revisions) == 2
    assert revisions[0] == original
    assert revisions[1].id != original.id
    assert revisions[1].match_rules == original.match_rules
    await uncut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    await db_session.refresh(event)
    event.match_settings = {"rated": False, "length_games": 1}
    await db_session.commit()
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    await db_session.refresh(event)
    assert event.current_rule_revision.match_rules["best_of"] == 1
    assert event.current_rule_revision.match_rules["affects_rating"] is False
    retained = (
        await db_session.execute(
            text(
                "SELECT id, match_rules, format_rules FROM tournament_draw_revisions "
                "WHERE id=:id"
            ),
            {"id": original.id},
        )
    ).one()
    assert retained == original
    await delete_event(db_session, tournament_id=tid, event_id=eid, actor=owner)
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM tournament_draw_revisions WHERE event_id=:id"),
            {"id": eid},
        )
        == 0
    )


async def test_qualification_count_is_frozen_before_any_group_finishes(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.draws import DrawConfig, Entrant, EntryId, GroupId, order_entrants
    from app.tournament_draws import strategy_for_event
    from app.tournament_events import create_event
    from tests.test_tournament_events import _event_payload

    owner = await make_user(db_session, "rules-qualification-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tid = tournament.id
    event, _ = await create_event(
        db_session,
        tournament_id=tid,
        actor=owner,
        payload=_event_payload(
            draw_type="rr-then-ko", qualifiers_per_group=2, predicates=[]
        ),
    )
    eid = event.id
    entries = await _enter_field(db_session, event, 4, prefix="rules-qualifier")
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    await db_session.refresh(event)
    event.draw_settings = TournamentEventDrawSettings.for_draw_type(
        DrawType.rr_then_ko, settings={"qualifiers_per_group": 1}
    )
    stages = {stage.position: stage.id for stage in event.stages}
    initial = tuple(
        GroupId(group.id) for group in event.groups if group.stage_id == stages[0]
    )
    knockout_group = next(
        GroupId(group.id) for group in event.groups if group.stage_id == stages[1]
    )
    from datetime import UTC, datetime

    planned = strategy_for_event(event).plan_initial(
        DrawConfig(group_ids=initial, knockout_group_id=knockout_group),
        order_entrants(
            [
                Entrant(
                    entry_id=EntryId(entry.id),
                    seed=n + 1,
                    created_at=datetime(2026, 1, 1, tzinfo=UTC),
                )
                for n, entry in enumerate(entries)
            ]
        ),
    )
    # The original two qualifiers still produce their final, despite planning K=1.
    assert len([fixture for fixture in planned if fixture.stage.position == 1]) == 1


async def test_unused_match_snapshot_does_not_prevent_permitted_event_deletion(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.models import MatchSettings
    from app.tournament_events import delete_event

    owner = await make_user(db_session, "rules-unused-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-unused-field")
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    await db_session.refresh(event)
    db_session.add(
        MatchSettings(
            team_size=1,
            best_of=5,
            source_rule_revision_id=event.current_rule_revision.id,
        )
    )
    await db_session.commit()
    await delete_event(db_session, tournament_id=tid, event_id=eid, actor=owner)
    assert await db_session.scalar(text("SELECT count(*) FROM match_settings")) == 0


async def test_surviving_materialized_match_blocks_event_deletion_with_domain_error(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.tournament_errors import RecordedPlayDeletionError
    from app.tournament_events import delete_event
    from app.tournament_materialization import materialize_event

    owner = await make_user(db_session, "rules-surviving-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    tid, eid = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="rules-surviving-field")
    await cut_event_draw(db_session, tournament_id=tid, event_id=eid, actor=owner)
    await materialize_event(db_session, tournament, event)
    await db_session.commit()
    with pytest.raises(RecordedPlayDeletionError, match="rule history"):
        await delete_event(db_session, tournament_id=tid, event_id=eid, actor=owner)
