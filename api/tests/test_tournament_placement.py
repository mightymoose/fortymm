"""Service-layer tests for the transport-neutral fixture-placement verb.

These drive ``app.tournament_placement.place_fixture`` directly with a raw
``db_session`` and no FastAPI — proving the write path (the owner-load, the fixture
load, the freeze, the pin/notify transition, the commit and read-back) runs, persists,
and signals every refusal with a **domain exception** from ``app.tournament_errors``
rather than an ``HTTPException``. The HTTP wire contract those exceptions map back to is
pinned by the unchanged endpoint tests in ``test_tournaments.py``; this file is the
branch matrix behind them.

The matrix is exactly: an owner places a fixture (the columns take effect and the full
placement silently pins pre-live), a non-owner is refused
(:class:`NotTournamentOwnerError`), an absent tournament is a not-found
(:class:`TournamentNotFoundError`), an absent/cross-tournament fixture is a not-found
(:class:`FixtureNotFoundError`), a played-out fixture's placement is frozen
(:class:`FixturePlacementFrozenError`), and a ``table_id`` naming no table of the
tournament is refused (:class:`PlacementTableNotFoundError`).

Those last two are the endpoint's only hard rules, and they are hard for different
reasons: the freeze is about the *state* of the fixture (ADR-0790), the table is about
the *content* of the body (ADR 20260801 — "a placement names a real table, and only that
is an invariant"). Everything else stays soft, which the out-of-window test at the
bottom of this file exists to hold in place: it is the one that would red if the FK
tempted somebody into validating the whole placement.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    EventFormat,
    League,
    Match,
    MatchSettings,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import TournamentFixturePlacementUpdate
from app.tournament_draws import cut_draw
from app.tournament_errors import (
    FixtureNotFoundError,
    FixturePlacementFrozenError,
    NotTournamentOwnerError,
    PlacementClashError,
    PlacementTableNotFoundError,
    TournamentNotFoundError,
)
from app.tournament_event_stages import mint_stages
from app.tournament_placement import place_fixture
from app.tournament_queries import stage_ids_for_events
from tests._entry_seeds import seed_fixture_match_sides
from tests._helpers import (
    make_user,
    venue_tables,
    with_table_aliases,
)


def _table(tournament: Tournament, position: int) -> str:
    """The id of ``tournament``'s ``position``-th catalogue table (1-based), as the
    text a placement carries.

    Table ids are the server's UUIDs since ADR 20260801, so a test cannot spell one as
    a literal — and now that ``table_id`` is a foreign key it cannot invent one either.
    Positional, in the tournament's own catalogue order, exactly like the ``"t1"``
    aliases the reservation seeds use."""
    return str(tournament.tables[position - 1].id)


async def _seed_placeable_fixture(
    db: AsyncSession,
    owner: User,
    league: League,
    *,
    status: TournamentStatus = TournamentStatus.draft,
) -> tuple[Tournament, TournamentEvent, TournamentFixture]:
    """A tournament owned by ``owner`` with one singles event and one fixture seating
    two active entrants — written straight to the database, the state the place verb's
    load path expects. The catalogue carries two real ``tournament_tables`` rows so a
    placement can name a real table (it must, since ADR 20260801 made ``table_id`` a
    foreign key), and the event's group — whose mapped reservation reserves the
    first of them and runs 09:00–12:30 — anchors the fixture."""
    tournament = Tournament(
        name="Placement Cup",
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
        status=status,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=64,
        entry_fee=Decimal("45"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        stages=stages,
    )
    groups = with_table_aliases(
        event,
        tournament,
        [
            {
                "name": "Reservation A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1"],
            }
        ],
    )
    stages[0].groups = groups
    db.add(event)
    await db.commit()
    # Captured before ``db.refresh(event)`` below, which expires ``event.stages`` (a
    # genuinely LOADED collection — unlike the VIEWONLY ``event.groups``) along with it;
    # re-reading ``stages[0].id``/``groups[0].id`` afterward would be an async lazy load
    # on the now-expired child objects.
    stage0_id, group0_id = stages[0].id, groups[0].id
    await db.refresh(event)
    entry_a = TournamentEntry(
        event_id=event.id,
        user_id=(await make_user(db, "place-a-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    entry_b = TournamentEntry(
        event_id=event.id,
        user_id=(await make_user(db, "place-b-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    db.add_all([entry_a, entry_b])
    await db.commit()
    fixture = TournamentFixture(
        stage_id=stage0_id,
        group_id=group0_id,
        round=1,
        position=1,
        entry_a_id=entry_a.id,
        entry_b_id=entry_b.id,
    )
    db.add(fixture)
    await db.commit()
    await db.refresh(fixture)
    return tournament, event, fixture


def _placement(
    table_id: str | None, scheduled_start: datetime | None
) -> TournamentFixturePlacementUpdate:
    """A placement body, validated through the same schema the HTTP route parses."""
    return TournamentFixturePlacementUpdate(
        table_id=table_id, scheduled_start=scheduled_start
    )


async def test_owner_places_a_fixture_and_the_columns_take_effect(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The owner sets a full placement (a REAL table + a naive wall-clock start): the
    returned read carries both, and the persisted fixture row records them — and,
    because a full placement of a known-entrant fixture is a pin, ``pinned_at`` is set
    (silently, since the tournament is a pre-live draft).

    The other half of ADR 20260801's invariant, and the reason it is worth asserting
    that this still works: making a bogus ``table_id`` a refusal must not make a real
    one one."""
    owner = await make_user(db_session, "place-owner")
    tournament, event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id
    table_id = _table(tournament, 1)

    read = await place_fixture(
        db_session,
        tournament_id=tournament.id,
        fixture_id=fixture_id,
        actor=owner,
        placement=_placement(table_id, datetime(2026, 6, 13, 10, 0)),
    )

    assert read.id == fixture_id
    assert read.table_id == table_id
    assert read.scheduled_start is not None

    # The columns are durable, and the full placement pinned the fixture.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id == table_id
    assert row.scheduled_start is not None
    assert row.pinned_at is not None


async def test_non_owner_cannot_place_a_fixture(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who is not the tournament's creator is refused with
    :class:`NotTournamentOwnerError` — owner-gated by construction — and the fixture is
    left unplaced (no columns, no pin)."""
    owner = await make_user(db_session, "place-guard-owner")
    stranger = await make_user(db_session, "place-stranger")
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id

    with pytest.raises(NotTournamentOwnerError):
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=fixture_id,
            actor=stranger,
            placement=_placement(_table(tournament, 1), datetime(2026, 6, 13, 10, 0)),
        )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.scheduled_start is None
    assert row.pinned_at is None


async def test_absent_tournament_is_a_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An id that names no tournament raises :class:`TournamentNotFoundError` — the 404
    judged before the fixture is even looked at (the locked owner-load runs first)."""
    owner = await make_user(db_session, "place-absent-tournament")

    with pytest.raises(TournamentNotFoundError):
        await place_fixture(
            db_session,
            tournament_id=uuid.uuid4(),
            fixture_id=uuid.uuid4(),
            actor=owner,
            placement=_placement(None, None),
        )


async def test_a_fixture_not_under_the_tournament_is_a_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The fixture is scoped by BOTH ids: a fixture id that names nothing, and a real
    fixture that belongs to a *different* tournament addressed through this one, are
    each a :class:`FixtureNotFoundError` — not a cross-tournament placement
    (ADR-0790)."""
    owner = await make_user(db_session, "place-scope-owner")
    tournament, _event, _fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    # A second tournament (same owner) whose fixture must not be addressable through the
    # first tournament's id.
    _other_t, _other_e, foreign = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    tournament_id = tournament.id
    foreign_id = foreign.id

    # A fixture id that names nothing at all.
    with pytest.raises(FixtureNotFoundError):
        await place_fixture(
            db_session,
            tournament_id=tournament_id,
            fixture_id=uuid.uuid4(),
            actor=owner,
            placement=_placement(None, None),
        )
    # A real fixture, but of the OTHER tournament, addressed through this one.
    with pytest.raises(FixtureNotFoundError):
        await place_fixture(
            db_session,
            tournament_id=tournament_id,
            fixture_id=foreign_id,
            actor=owner,
            placement=_placement(None, None),
        )


@pytest.mark.parametrize("frozen_status", [MatchStatus.completed, MatchStatus.voided])
async def test_a_played_out_fixture_refuses_the_placement(
    db_session: AsyncSession,
    default_league: League,
    frozen_status: MatchStatus,
) -> None:
    """The one hard rule (ADR-0790): a fixture whose linked match is ``completed`` or
    ``voided`` is history, so a placement is refused with
    :class:`FixturePlacementFrozenError` — carrying the match status the adapter names —
    and nothing is written. ``in_progress`` is NOT a freeze trigger, so only these two
    terminal statuses reach here."""
    owner = await make_user(db_session, "place-frozen-owner")
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=False),
        league_id=default_league.id,
        created_by_user_id=owner.id,
    )
    match.status = frozen_status
    db_session.add(match)
    await db_session.commit()
    await seed_fixture_match_sides(db_session, fixture, match)
    fixture.match_id = match.id
    await db_session.commit()

    with pytest.raises(FixturePlacementFrozenError) as exc_info:
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=fixture_id,
            actor=owner,
            placement=_placement(_table(tournament, 1), datetime(2026, 6, 13, 10, 0)),
        )
    assert exc_info.value.match_status == frozen_status.value

    # The refusal wrote nothing: the fixture stays unplaced.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.scheduled_start is None
    assert row.pinned_at is None


@pytest.mark.parametrize(
    ("bogus", "why"),
    [
        (str(uuid.uuid4()), "a well-formed id that names no row"),
        ("t1", "not even a well-formed id"),
    ],
)
async def test_a_table_id_naming_no_table_is_refused(
    db_session: AsyncSession,
    default_league: League,
    bogus: str,
    why: str,
) -> None:
    """A placement whose ``table_id`` names no table of this tournament raises
    :class:`PlacementTableNotFoundError` — where it used to be **stored, and answered
    200** (ADR-0790's fourth, weakest clause, superseded by ADR 20260801).

    Both flavours of "no table" get the one refusal, carrying the offending id: a
    well-formed UUID matching no row, and a string that is not a UUID at all (the
    ``"t1"`` a client of the JSONB catalogue would have sent). One question, one answer
    — the caller is not asked to tell a malformed id from an unknown one.

    Nothing is written: the fixture is left unplaced, which is the point. A refusal that
    half-applied would be worse than the storing it replaces."""
    owner = await make_user(db_session, f"place-bogus-{uuid.uuid4().hex[:8]}")
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id

    with pytest.raises(PlacementTableNotFoundError) as exc_info:
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=fixture_id,
            actor=owner,
            placement=_placement(bogus, datetime(2026, 6, 13, 10, 0)),
        )
    assert exc_info.value.table_id == bogus, why

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.scheduled_start is None
    assert row.pinned_at is None


async def test_another_tournaments_table_is_refused(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A real ``tournament_tables`` row — of somebody *else's* tournament — is refused
    too, which the foreign key alone could not do: the key only knows the row exists
    somewhere.

    From this fixture's page that id resolves to nothing renderable, so it is the same
    dangling pointer the ADR makes unrepresentable, and it gets the same refusal. Not a
    fourth constraint: the invariant is "names a real table", asked of the only
    catalogue this placement can be read against."""
    owner = await make_user(db_session, "place-foreign-table-owner")
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    other, _other_event, _other_fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    foreign_table_id = _table(other, 1)
    fixture_id = fixture.id

    with pytest.raises(PlacementTableNotFoundError) as exc_info:
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=fixture_id,
            actor=owner,
            placement=_placement(foreign_table_id, datetime(2026, 6, 13, 10, 0)),
        )
    assert exc_info.value.table_id == foreign_table_id


async def test_an_out_of_window_start_still_saves_as_a_flag(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The placement is still SOFT everywhere ADR-0790 made it soft. A start hours
    outside the fixture's reservation window (09:00–12:30) on a table outside the
    reservation's
    ``table_ids`` saves — and pins — exactly as an in-window one does: no refusal, no
    ``None`` columns, the time the director asked for.

    This is the test that would red if the foreign key were read as licence to validate
    the whole placement rather than the one claim ADR 20260801 hardened. A
    reservation's tables and window stay editable under a standing draw precisely
    because the venue changes under a running tournament, so a placement a later edit
    outranges is a flag
    derived on read, never a refusal."""
    owner = await make_user(db_session, "place-out-of-window-owner")
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    fixture_id = fixture.id
    # Table 2 is in the catalogue but NOT in the group's reservation's ``table_ids``,
    # and 23:30 is long past the reservation's 12:30 end — two flags in one placement.
    off_group_table = _table(tournament, 2)
    out_of_window = datetime(2026, 6, 13, 23, 30)

    read = await place_fixture(
        db_session,
        tournament_id=tournament.id,
        fixture_id=fixture_id,
        actor=owner,
        placement=_placement(off_group_table, out_of_window),
    )

    assert read.table_id == off_group_table
    assert read.scheduled_start is not None

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id == off_group_table
    assert row.scheduled_start is not None
    # The venue-anchored instant of 23:30 America/Chicago, stored as it was asked for.
    assert (
        row.scheduled_start.astimezone(ZoneInfo("America/Chicago")).replace(tzinfo=None)
        == out_of_window
    )
    assert row.pinned_at is not None


# ----- a live call that clashes is refused (ADR "A called match holds its ----
# time, and a clashing call is refused") -------------------------------------

_CLASH_TAGS = ("clash-a", "clash-b", "clash-c", "clash-d")


async def _seed_live_four_way_tournament(
    db: AsyncSession,
    owner: User,
    league: League,
    *,
    status: TournamentStatus = TournamentStatus.live,
) -> tuple[Tournament, TournamentEvent, dict[str, TournamentFixture]]:
    """A tournament with four entrants (``clash-a``..``clash-d``) and two
    tables, cut as a single-group round robin — six fixtures pairing every
    entrant against every other, on one reservation spanning both tables.

    Returns the fixtures keyed by their two entrants' usernames, sorted and
    joined with ``" vs "`` (e.g. ``"clash-a vs clash-b"``), so a clash test can
    address the fixture it needs by the players it names rather than by
    draw-order position."""
    tournament = Tournament(
        name="Clash Cup",
        status=status,
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
    )
    db.add(tournament)
    await db.flush()
    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": False, "length_games": 1},
        stages=stages,
    )
    stages[0].groups = with_table_aliases(
        event,
        tournament,
        [
            {
                "name": "Reservation A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
                "table_ids": ["t1", "t2"],
            }
        ],
    )
    db.add(event)
    await db.flush()
    await db.refresh(event, attribute_names=["groups"])

    # Plain tags, not uuid-suffixed: the ``db_session`` fixture truncates every
    # table between tests, so these never collide with another test's rows,
    # and the plain names are what make the fixture-lookup-by-pair below (and
    # the assertions on the refusal sentence) readable.
    users: dict[str, User] = {tag: await make_user(db, tag) for tag in _CLASH_TAGS}
    for user in users.values():
        db.add(TournamentEntry(event_id=event.id, user_id=user.id))
    await db.flush()
    await db.commit()
    await db.refresh(event, attribute_names=["groups"])

    await cut_draw(db, event)
    await db.commit()

    fixtures = (
        (
            await db.execute(
                select(TournamentFixture)
                .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event.id])))
                .order_by(TournamentFixture.id)
            )
        )
        .scalars()
        .all()
    )
    entry_user: dict[uuid.UUID, uuid.UUID] = {
        entry_id: user_id
        for entry_id, user_id in (
            await db.execute(
                select(TournamentEntry.id, TournamentEntry.user_id).where(
                    TournamentEntry.event_id == event.id
                )
            )
        ).all()
    }
    user_username = {user.id: tag for tag, user in users.items()}
    by_pair: dict[str, TournamentFixture] = {}
    for fixture in fixtures:
        # A round-robin cut always seats both sides — assert rather than
        # silently skip, so a draw-shape regression fails loudly here.
        assert fixture.entry_a_id is not None
        assert fixture.entry_b_id is not None
        a = user_username[entry_user[fixture.entry_a_id]]
        b = user_username[entry_user[fixture.entry_b_id]]
        key = " vs ".join(sorted((a, b)))
        by_pair[key] = fixture
    return tournament, event, by_pair


async def _call_fixture_directly(
    db: AsyncSession,
    tournament: Tournament,
    fixture: TournamentFixture,
    *,
    table_id: str,
    start: datetime,
) -> None:
    """Manufacture an already-**called** (``in_progress``, pinned, told) state
    on ``fixture`` directly on the rows, bypassing the real call pipeline —
    exactly the "state manufacturing for unit tests" convention
    ``tests/test_match_calls.py``'s ``_pin_directly``/``_link_match`` use.
    The clash tests need an exact held pre-state, not a solve."""
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=1, affects_rating=False),
        league_id=tournament.league_id,
        created_by_user_id=tournament.created_by_user_id,
        status=MatchStatus.in_progress,
    )
    db.add(match)
    await db.flush()
    # ``scheduled_start``/``pinned_at`` are ``timestamptz`` (api/CLAUDE.md: seed
    # aware). ``start`` is handed in as the naive wall-clock the other seeds in
    # this file use; anchor it to a real instant the same way the write path
    # (``anchor_wallclock``) does, so a later comparison against another
    # fixture's already-anchored ``scheduled_start`` never trips a naive/aware
    # ``TypeError``.
    anchored = start.replace(tzinfo=UTC)
    await seed_fixture_match_sides(db, fixture, match)
    fixture.match_id = match.id
    fixture.table_id = table_id
    fixture.scheduled_start = anchored
    fixture.pinned_at = anchored
    fixture.call_notified_count = 1
    await db.commit()


async def test_live_call_onto_a_held_table_is_refused(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A live full placement that would land onto a table an unfinished
    ``in_progress`` match already occupies is refused with
    :class:`PlacementClashError`, naming the table — even though the fixture
    being placed shares no player with the held match. Nothing is written."""
    owner = await make_user(db_session, f"clash-owner-{uuid.uuid4().hex[:8]}")
    tournament, _event, fixtures = await _seed_live_four_way_tournament(
        db_session, owner, default_league
    )
    held = fixtures["clash-a vs clash-b"]
    table1 = _table(tournament, 1)
    await _call_fixture_directly(
        db_session,
        tournament,
        held,
        table_id=table1,
        start=datetime(2026, 6, 13, 9, 30),
    )
    # Disjoint players from the held match, same table.
    challenger = fixtures["clash-c vs clash-d"]
    challenger_id = challenger.id

    with pytest.raises(PlacementClashError) as exc_info:
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=challenger_id,
            actor=owner,
            placement=_placement(table1, datetime(2026, 6, 13, 9, 35)),
        )
    message = str(exc_info.value)
    assert "Table 1" in message
    assert "clash-a" in message
    assert "clash-b" in message
    assert "called there" in message

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == challenger_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.scheduled_start is None
    assert row.pinned_at is None


@pytest.mark.parametrize("transferred", [False, True])
async def test_live_call_onto_a_held_player_is_refused(
    transferred: bool,
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A live full placement onto a FREE table is still refused when one of
    its own players is held by an unfinished ``in_progress`` match elsewhere —
    naming the held player, not the table."""
    owner = await make_user(db_session, f"clash-owner-{uuid.uuid4().hex[:8]}")
    tournament, _event, fixtures = await _seed_live_four_way_tournament(
        db_session, owner, default_league
    )
    held = fixtures["clash-a vs clash-b"]
    table1 = _table(tournament, 1)
    await _call_fixture_directly(
        db_session,
        tournament,
        held,
        table_id=table1,
        start=datetime(2026, 6, 13, 9, 30),
    )
    # Shares "clash-a" with the held match, but a DIFFERENT (free) table.
    challenger = fixtures["clash-a vs clash-c"]
    challenger_id = challenger.id
    table2 = _table(tournament, 2)

    if transferred:
        from app.account_merge import merge_user
        from app.models import Account

        source = await db_session.scalar(
            select(Account).where(Account.username == "clash-a")
        )
        destination = Account(email="placement-transfer@example.com")
        db_session.add(destination)
        await db_session.commit()
        await merge_user(db_session, from_user_id=source.id, to_user_id=destination.id)
        await db_session.commit()
        assert destination.player_id != destination.id

    with pytest.raises(PlacementClashError) as exc_info:
        await place_fixture(
            db_session,
            tournament_id=tournament.id,
            fixture_id=challenger_id,
            actor=owner,
            placement=_placement(table2, datetime(2026, 6, 13, 9, 35)),
        )
    message = str(exc_info.value)
    assert "clash-a" in message
    assert "already called" in message
    assert "Table 1" in message  # the table the held match is AT, not table 2
    assert "clash-b" in message

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == challenger_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.pinned_at is None


async def test_re_placing_the_in_progress_fixture_itself_is_not_a_clash(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Re-placing the SAME fixture that is already ``in_progress`` and called
    onto its own table is a move, not a clash — ``_held_resources`` excludes
    the fixture's own match, so this succeeds (200-equivalent: no exception)."""
    owner = await make_user(db_session, f"clash-owner-{uuid.uuid4().hex[:8]}")
    tournament, _event, fixtures = await _seed_live_four_way_tournament(
        db_session, owner, default_league
    )
    held = fixtures["clash-a vs clash-b"]
    table1 = _table(tournament, 1)
    await _call_fixture_directly(
        db_session,
        tournament,
        held,
        table_id=table1,
        start=datetime(2026, 6, 13, 9, 30),
    )
    held_id = held.id

    read = await place_fixture(
        db_session,
        tournament_id=tournament.id,
        fixture_id=held_id,
        actor=owner,
        placement=_placement(table1, datetime(2026, 6, 13, 9, 40)),
    )

    assert read.id == held_id
    assert read.table_id == table1


async def test_live_call_with_a_free_table_and_free_players_still_calls(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """No over-refusal: a live placement onto a free table with free players
    still succeeds and calls the fixture, even with another match running
    elsewhere (different table, different humans)."""
    owner = await make_user(db_session, f"clash-owner-{uuid.uuid4().hex[:8]}")
    tournament, _event, fixtures = await _seed_live_four_way_tournament(
        db_session, owner, default_league
    )
    held = fixtures["clash-a vs clash-b"]
    table1 = _table(tournament, 1)
    await _call_fixture_directly(
        db_session,
        tournament,
        held,
        table_id=table1,
        start=datetime(2026, 6, 13, 9, 30),
    )
    free = fixtures["clash-c vs clash-d"]
    free_id = free.id
    table2 = _table(tournament, 2)

    read = await place_fixture(
        db_session,
        tournament_id=tournament.id,
        fixture_id=free_id,
        actor=owner,
        placement=_placement(table2, datetime(2026, 6, 13, 9, 35)),
    )

    assert read.id == free_id
    assert read.table_id == table2
    assert read.pinned_at is not None

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == free_id)
        )
    ).scalar_one()
    assert row.table_id == table2
    assert row.pinned_at is not None
    assert row.call_notified_count == 1


async def test_pre_live_table_and_player_overlap_still_saves_as_a_flag(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Pre-live (ADR-0790), the same table/player overlap that a live call
    refuses SAVES silently, as a flag on read, exactly as it always has —
    a pre-live placement calls nobody, so there is nothing to clash with."""
    owner = await make_user(db_session, f"clash-owner-{uuid.uuid4().hex[:8]}")
    tournament, _event, fixtures = await _seed_live_four_way_tournament(
        db_session, owner, default_league, status=TournamentStatus.draft
    )
    held = fixtures["clash-a vs clash-b"]
    table1 = _table(tournament, 1)
    # A pre-live tournament never links a real in_progress match through the
    # ordinary pipeline, but the clash guard only cares whether the row is
    # readable as held — manufacture the same in_progress fact directly, the
    # way the two refusal tests above do, to prove the STATUS gate (not the
    # absence of held state) is what makes this save.
    await _call_fixture_directly(
        db_session,
        tournament,
        held,
        table_id=table1,
        start=datetime(2026, 6, 13, 9, 30),
    )
    challenger = fixtures["clash-c vs clash-d"]
    challenger_id = challenger.id

    read = await place_fixture(
        db_session,
        tournament_id=tournament.id,
        fixture_id=challenger_id,
        actor=owner,
        placement=_placement(table1, datetime(2026, 6, 13, 9, 35)),
    )

    assert read.id == challenger_id
    assert read.table_id == table1
