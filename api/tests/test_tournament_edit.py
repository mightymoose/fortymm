"""Service-layer tests for the transport-neutral ``edit_tournament`` verb.

These drive ``app.tournament_edit.edit_tournament`` directly with a raw
``db_session`` and no FastAPI — proving the write path (owner gate, league
state-rule, STRICT league lookup, table-catalogue → re-solve) runs, persists,
and signals every refusal with a **domain exception** from
``app.tournament_errors`` rather than an ``HTTPException``. The HTTP wire contract
those exceptions map back to is pinned by the unchanged endpoint tests in
``test_tournaments.py``; this file is the branch matrix behind them.
"""

import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.geocoding import (
    AddressNotGeocodableError,
    FakeGeocoder,
    GeocodeResult,
    compose_address,
)
from app.models import (
    League,
    LeagueVisibility,
    RatingStrategy,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.tournament import DrawType, EventFormat
from app.schemas.tournament import AddressInput, TournamentTable, TournamentUpdate
from app.tournament_edit import edit_tournament
from app.tournament_errors import (
    LeagueNotEditableError,
    LeagueNotFoundError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)
from tests._helpers import make_user

# The keyless deterministic geocoder the edit verb re-geocodes a changed address with
# (the same one ``get_geocoder`` hands out with no ``GOOGLE_GEOCODING_API_KEY``). A
# service-layer test builds it directly, exactly as it constructs the raw session.
_GEOCODER = FakeGeocoder()


class _CountingGeocoder:
    """A ``Geocoder`` that records how many times it was asked to geocode, delegating to
    the deterministic ``FakeGeocoder`` so results stay stable.

    Lets a test assert the edit verb geocodes **only** when the address text actually
    changes — a name-only edit, or one that resubmits the identical address, must never
    pay for a geocode (and, in production, must never hold the row lock across the
    network call). Structurally satisfies the ``Geocoder`` protocol, so it is injected
    exactly where the real geocoder would be."""

    def __init__(self) -> None:
        self.calls = 0
        self._inner = FakeGeocoder()

    async def geocode(self, address: str) -> GeocodeResult:
        self.calls += 1
        return await self._inner.geocode(address)


async def _geocoded(address: dict[str, str]) -> dict[str, object]:
    """The stored address dict the verb writes for ``address``: its six text fields
    plus the coordinates the deterministic ``FakeGeocoder`` resolves them to — computed
    through the very geocoder the verb uses, so the expectation cannot drift from it."""
    result = await _GEOCODER.geocode(compose_address(**address))
    return {**address, "latitude": result.latitude, "longitude": result.longitude}


@pytest_asyncio.fixture
async def other_league(
    db_session: AsyncSession, rating_strategies: dict[str, RatingStrategy]
) -> League:
    """A second, non-default league — so "moved to the league the caller named"
    is distinguishable from "carries the default, always" (the two ids differ).
    Mirrors the fixture of the same name in ``test_tournaments.py``."""
    league = League(
        name="Bay Area Ladder",
        description="A second ladder. Not the default.",
        visibility=LeagueVisibility.public,
        is_default=False,
        rating_strategy_id=rating_strategies["glicko2"].id,
    )
    db_session.add(league)
    await db_session.commit()
    return league


def _address() -> dict[str, str]:
    # The write shape (``AddressInput``): six text components, no coordinates. Used
    # to build ``TournamentUpdate`` payloads. Stored seeds add coordinates via
    # ``_stored_address``.
    return {
        "venue": "Berkeley TT Club",
        "street": "2727 Milvia St",
        "city": "Berkeley",
        "region": "CA",
        "postal": "94703",
        "country": "USA",
    }


def _stored_address() -> dict[str, object]:
    # The stored/read shape a ``Tournament`` row holds: the write fields plus the
    # NOT NULL geocoded coordinates.
    return {**_address(), "latitude": 37.8703, "longitude": -122.2731}


async def _make_tournament(
    db: AsyncSession,
    *,
    owner: User,
    league: League,
    status: TournamentStatus = TournamentStatus.draft,
    table_catalogue: list[dict[str, str]] | None = None,
) -> Tournament:
    tournament = Tournament(
        name="Bay Area Open 2026",
        description="Two-day open.",
        address=_stored_address(),
        table_catalogue=table_catalogue
        or [
            {"id": "t1", "label": "Table 1", "court": "A"},
            {"id": "t2", "label": "Table 2", "court": "A"},
        ],
        league_id=league.id,
        created_by_user_id=owner.id,
        status=status,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def _draw_an_event(db: AsyncSession, tournament: Tournament) -> None:
    """Give the tournament one event with one cut fixture, so
    ``tournament_has_drawn_event`` answers True."""
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_type=DrawType.single_elim,
        max_players=64,
        entry_fee=Decimal("45"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        pools=[],
    )
    db.add(event)
    await db.flush()
    db.add(TournamentFixture(event_id=event.id, pool_id=None, round=1, position=1))
    await db.commit()


async def _persisted_league_id(db: AsyncSession, tournament_id: uuid.UUID) -> uuid.UUID:
    return (
        (await db.execute(select(Tournament).where(Tournament.id == tournament_id)))
        .scalar_one()
        .league_id
    )


async def _queued_solves(
    db: AsyncSession, tournament_id: uuid.UUID
) -> list[ScheduleSolve]:
    db.expire_all()
    return list(
        (
            await db.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        )
        .scalars()
        .all()
    )


# ----- owner edit succeeds + persists ---------------------------------------


async def test_owner_edit_updates_and_persists(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-edit")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    # Capture the PK before the verb commits — the commit expires ``tournament``,
    # so reading ``tournament.id`` afterwards would trigger a sync lazy-load.
    tournament_id = tournament.id

    new_address = {**_address(), "venue": "Palo Alto Community Center"}
    result = await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(
            name="Bay Area Major",
            address=AddressInput(**new_address),
        ),
        geocoder=_GEOCODER,
    )

    # The changed address is re-geocoded on write: the stored value is the six text
    # fields plus the coordinates the geocoder resolved (NOT NULL, ADR-geocoded venues).
    expected_address = await _geocoded(new_address)
    assert result.name == "Bay Area Major"
    assert result.address == expected_address
    # The edit does not touch the lifecycle.
    assert result.status is TournamentStatus.draft

    # Persisted on the row, not merely returned.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.name == "Bay Area Major"
    assert row.address == expected_address


async def test_unresolvable_new_address_raises_and_writes_nothing(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A changed address the geocoder cannot resolve (the ``FakeGeocoder``
    ``__unresolvable__`` sentinel) raises ``AddressNotGeocodableError`` before any
    field is written — the edit is atomic, so the stored address (and its coordinates)
    is left exactly as it was. The verb never writes a coordinate-less address."""
    owner = await make_user(db_session, "owner-bad-address")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    bad_address = {**_address(), "venue": "__unresolvable__"}
    with pytest.raises(AddressNotGeocodableError):
        await edit_tournament(
            db_session,
            tournament_id=tournament_id,
            actor=owner,
            updates=TournamentUpdate(
                name="Should Not Persist",
                address=AddressInput(**bad_address),
            ),
            geocoder=_GEOCODER,
        )

    # Nothing was written: neither the name nor the original stored address moved.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.name == "Bay Area Open 2026"
    assert row.address == _stored_address()


# ----- geocode ONLY when the address text actually changes -------------------


async def test_name_only_edit_does_not_geocode(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A patch that carries no address geocodes nothing — the stored address and its
    coordinates are left untouched, and the geocoder is never called."""
    owner = await make_user(db_session, "owner-name-only")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    counting = _CountingGeocoder()
    await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(name="Renamed, Same Venue"),
        geocoder=counting,
    )

    assert counting.calls == 0
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.name == "Renamed, Same Venue"
    # The stored address — coordinates included — did not move.
    assert row.address == _stored_address()


async def test_resubmitting_the_identical_address_does_not_geocode(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Resubmitting the SAME six address text fields (as the web client does on every
    edit) geocodes nothing — the six stored text fields are unchanged, so the stored
    coordinates are preserved rather than recomputed. Only the other edited field moves.
    """
    owner = await make_user(db_session, "owner-same-address")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    counting = _CountingGeocoder()
    await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        # The address is byte-for-byte the stored one; only the name changes.
        updates=TournamentUpdate(
            name="Bay Area Major",
            address=AddressInput(**_address()),
        ),
        geocoder=counting,
    )

    assert counting.calls == 0
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.name == "Bay Area Major"
    # The stored coordinates were kept, not re-derived (the seed's coordinates are NOT
    # the ``FakeGeocoder`` output for this address, so a stray re-geocode would show).
    assert row.address == _stored_address()


async def test_changed_address_geocodes_exactly_once(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A genuinely different address IS geocoded — exactly once — and the stored
    coordinates are the ones the geocoder resolved, beside the new six text fields."""
    owner = await make_user(db_session, "owner-new-address")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    counting = _CountingGeocoder()
    new_address = {**_address(), "venue": "Palo Alto Community Center"}
    result = await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(address=AddressInput(**new_address)),
        geocoder=counting,
    )

    assert counting.calls == 1
    # The new venue's six text fields plus the coordinates the geocoder resolved.
    assert result.address == await _geocoded(new_address)
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.address == await _geocoded(new_address)


# ----- non-owner is refused with a domain exception -------------------------


async def test_non_owner_raises_not_owner(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-guard")
    stranger = await make_user(db_session, "stranger")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    with pytest.raises(NotTournamentOwnerError):
        await edit_tournament(
            db_session,
            tournament_id=tournament_id,
            actor=stranger,
            updates=TournamentUpdate(name="Hijack"),
            geocoder=_GEOCODER,
        )

    # Nothing was written.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.name == "Bay Area Open 2026"


async def test_missing_tournament_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-missing")

    with pytest.raises(TournamentNotFoundError):
        await edit_tournament(
            db_session,
            tournament_id=uuid.uuid4(),
            actor=owner,
            updates=TournamentUpdate(name="Nowhere"),
            geocoder=_GEOCODER,
        )


# ----- league state-rule and STRICT lookup ----------------------------------


async def test_league_change_while_draft_moves_the_ladder(
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
) -> None:
    owner = await make_user(db_session, "owner-league-draft")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    result = await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(league_id=other_league.id),
        geocoder=_GEOCODER,
    )

    assert result.league_id == other_league.id
    assert await _persisted_league_id(db_session, tournament_id) == other_league.id


@pytest.mark.parametrize(
    "status",
    [TournamentStatus.published, TournamentStatus.live, TournamentStatus.archived],
    ids=lambda s: s.value,
)
async def test_league_change_after_publish_raises_not_editable(
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
    status: TournamentStatus,
) -> None:
    owner = await make_user(db_session, f"owner-league-{status.value}")
    tournament = await _make_tournament(
        db_session, owner=owner, league=default_league, status=status
    )
    tournament_id = tournament.id

    with pytest.raises(LeagueNotEditableError) as excinfo:
        await edit_tournament(
            db_session,
            tournament_id=tournament_id,
            actor=owner,
            updates=TournamentUpdate(league_id=other_league.id),
            geocoder=_GEOCODER,
        )

    # Carries the current status, so the HTTP adapter can rebuild the exact 409
    # body (and the message the adapter sends is `status.value` verbatim).
    assert excinfo.value.status == status.value
    assert status.value in str(excinfo.value)
    # The ladder did not move.
    assert await _persisted_league_id(db_session, tournament_id) == default_league.id


async def test_league_that_names_no_league_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "owner-bad-league")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    with pytest.raises(LeagueNotFoundError):
        await edit_tournament(
            db_session,
            tournament_id=tournament_id,
            actor=owner,
            updates=TournamentUpdate(league_id=uuid.uuid4()),
            geocoder=_GEOCODER,
        )

    # The STRICT lookup did not silently swap the ladder to the default.
    assert await _persisted_league_id(db_session, tournament_id) == default_league.id


# ----- table-catalogue change on a drawn tournament requests a solve --------


async def test_table_catalogue_change_on_a_drawn_tournament_requests_a_solve(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Re-identifying a table changes the solver's inputs, and the tournament has a
    cut draw, so the edit queues a ``settings_changed`` solve in the same
    transaction."""
    owner = await make_user(db_session, "owner-solve")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    await _draw_an_event(db_session, tournament)

    assert await _queued_solves(db_session, tournament_id) == []

    # The intervening commits (draw + the solve-ledger read) expired ``owner``;
    # a real request holds a freshly-loaded ``current_user``, so refresh it back
    # to a loaded state before handing it to the verb.
    await db_session.refresh(owner)
    await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(
            table_catalogue=[
                TournamentTable(id="t1", label="Table 1", court="A"),
                TournamentTable(id="t3", label="Table 3", court="B"),
            ]
        ),
        geocoder=_GEOCODER,
    )

    (solve,) = await _queued_solves(db_session, tournament_id)
    assert solve.trigger is ScheduleSolveTrigger.settings_changed
    assert solve.status is ScheduleSolveStatus.queued


async def test_table_catalogue_change_without_a_draw_requests_no_solve(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """With no cut draw there is nothing to place, so the same catalogue change
    queues no solve — the drawn-event gate, verified from the negative side."""
    owner = await make_user(db_session, "owner-nosolve")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(
            table_catalogue=[
                TournamentTable(id="t9", label="Table 9", court="C"),
            ]
        ),
        geocoder=_GEOCODER,
    )

    assert await _queued_solves(db_session, tournament_id) == []
