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
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
    VenueTable,
)
from app.models.tournament import DrawType, EventFormat
from app.schemas.tournament import (
    AddressInput,
    TournamentTableWrite,
    TournamentUpdate,
)
from app.tournament_edit import edit_tournament
from app.tournament_errors import (
    LeagueNotEditableError,
    LeagueNotFoundError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)
from tests._helpers import (
    CountingGeocoder,
    assert_tournament_address_is_sql_null,
    blank_addresses,
    make_user,
    venue_tables,
)

# The deterministic geocoder the edit verb re-geocodes a changed address with (the
# same one ``get_geocoder`` hands out under the suite's ``GEOCODER=fake``). A
# service-layer test builds it directly, exactly as it constructs the raw session.
_GEOCODER = FakeGeocoder()


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
    catalogue: list[VenueTable] | None = None,
    with_venue: bool = True,
) -> Tournament:
    tournament = Tournament(
        name="Bay Area Open 2026",
        description="Two-day open.",
        # ``with_venue=False`` seeds the state #1206 made reachable: a tournament whose
        # address column is SQL NULL because it has no venue at all.
        address=_stored_address() if with_venue else None,
        tables=(
            catalogue
            if catalogue is not None
            else venue_tables(("Table 1", "A"), ("Table 2", "A"))
        ),
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
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.single_elim),
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


async def _catalogue_rows(
    db: AsyncSession, tournament_id: uuid.UUID
) -> list[VenueTable]:
    """The tournament's venue tables, straight off ``tournament_tables`` in the
    director's order — read from the rows and never off an ORM instance the verb under
    test still holds, so an assertion is about what was persisted."""
    db.expire_all()
    return list(
        (
            await db.execute(
                select(VenueTable)
                .where(VenueTable.tournament_id == tournament_id)
                .order_by(VenueTable.position)
            )
        )
        .scalars()
        .all()
    )


async def _catalogue_ids(db: AsyncSession, tournament_id: uuid.UUID) -> list[uuid.UUID]:
    return [row.id for row in await _catalogue_rows(db, tournament_id)]


async def _catalogue_labels(db: AsyncSession, tournament_id: uuid.UUID) -> list[str]:
    return [row.label for row in await _catalogue_rows(db, tournament_id)]


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
#
# The ``CountingGeocoder`` call count below is what makes these claims: the edit verb
# must geocode **only** when the address text actually changes — a name-only edit, or
# one that resubmits the identical address, must never pay for a geocode (and, in
# production, must never hold the row lock across the network call). A 200-equivalent
# cannot distinguish that from a geocode that happened to resolve.


async def test_name_only_edit_does_not_geocode(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A patch that carries no address geocodes nothing — the stored address and its
    coordinates are left untouched, and the geocoder is never called."""
    owner = await make_user(db_session, "owner-name-only")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    counting = CountingGeocoder()
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

    counting = CountingGeocoder()
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

    counting = CountingGeocoder()
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


# ----- removing the venue, and giving one to a tournament that has none ------


async def _address_of(db: AsyncSession, tournament_id: uuid.UUID) -> object:
    """The tournament's stored ``address`` column, read back fresh — what settles
    whether a removal reached the database at all.

    It settles *whether*, not *how*: a JSONB column deserializes both a true SQL NULL
    and a stored JSON ``null`` literal into Python ``None``, so this cannot tell the two
    encodings apart. Where the claim is about the encoding, pair it with
    :func:`tests._helpers.assert_tournament_address_is_sql_null`.
    """
    db.expire_all()
    return (
        (await db.execute(select(Tournament).where(Tournament.id == tournament_id)))
        .scalar_one()
        .address
    )


async def test_an_explicit_null_address_removes_the_venue(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """``address: null`` on a PATCH clears the stored venue — the organizer un-booked
    it.

    Before #1206 this was a 422 at the schema, so the verb never saw it. It is asserted
    *here*, on the verb, rather than only at the schema: accepting the ``null`` and
    writing it are two different claims, and only the second one is what an organizer
    asked for. The geocoder must not be called — there is no text to resolve, and asking
    it would resolve ``""`` to zero candidates and turn the removal into a coded 409.

    The cleared column is checked at the SQL level as well: a removal must leave the row
    in the *same* state as a tournament created without a venue — one true SQL NULL —
    rather than in a second, look-alike encoding that reads back as ``None`` but is
    invisible to ``IS NULL``.
    """
    owner = await make_user(db_session, "owner-clear-venue")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    counting = CountingGeocoder()
    result = await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(address=None),
        geocoder=counting,
    )

    assert counting.calls == 0
    assert result.address is None
    assert await _address_of(db_session, tournament_id) is None
    await assert_tournament_address_is_sql_null(db_session, tournament_id)


@blank_addresses
async def test_an_all_blank_address_removes_the_venue(
    db_session: AsyncSession,
    default_league: League,
    blank: dict[str, str],
) -> None:
    """The same removal through the gesture the **web form** can make.

    The form submits six controlled text inputs and has no way to omit the ``address``
    key, so clearing the boxes is how a browser organizer un-books a venue. The boundary
    normalizes that to ``null`` while leaving ``address`` in ``model_fields_set``, and
    the verb must read it as "remove" rather than "unchanged" — which is exactly the
    distinction ``updates.address is not None`` could not make.
    """
    owner = await make_user(db_session, "owner-blank-venue")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    counting = CountingGeocoder()
    result = await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(address=blank),
        geocoder=counting,
    )

    assert counting.calls == 0
    assert result.address is None
    assert await _address_of(db_session, tournament_id) is None
    await assert_tournament_address_is_sql_null(db_session, tournament_id)


async def test_removing_the_venue_leaves_the_rest_of_the_patch_applied(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A removal is an ordinary field in an ordinary partial patch — the other fields on
    the same payload still land. Guards against a future "handle address separately"
    refactor that returns early or drops the generic ``setattr`` loop."""
    owner = await make_user(db_session, "owner-clear-and-rename")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(name="Venue Cancelled", address=None),
        geocoder=_GEOCODER,
    )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.name == "Venue Cancelled"
    assert row.address is None


async def test_giving_a_venue_to_a_tournament_that_has_none_geocodes_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The other half of the round trip: a venue-less tournament gets an address, and it
    is geocoded exactly once and stored **with** its coordinates.

    Newly reachable — before #1206 no tournament could be in this state. It also
    exercises the ``stored is None`` arm of the lock-free change-detection read, which
    now means "this tournament has no venue" as well as "this unlocked read cannot see
    it": either way the submitted address is a change and must be resolved.
    """
    owner = await make_user(db_session, "owner-book-venue")
    tournament = await _make_tournament(
        db_session, owner=owner, league=default_league, with_venue=False
    )
    tournament_id = tournament.id
    assert tournament.address is None

    counting = CountingGeocoder()
    result = await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(address=AddressInput(**_address())),
        geocoder=counting,
    )

    assert counting.calls == 1
    assert result.address == await _geocoded(_address())
    assert await _address_of(db_session, tournament_id) == await _geocoded(_address())


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


async def test_adding_a_table_on_a_drawn_tournament_requests_a_solve(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A table the venue did not have is a new place to put a match — the solver's
    inputs changed — and the tournament has a cut draw, so the edit queues a
    ``settings_changed`` solve in the same transaction."""
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
                TournamentTableWrite(label="Table 1", court="A"),
                TournamentTableWrite(label="Table 2", court="A"),
                TournamentTableWrite(label="Table 3", court="B"),
            ]
        ),
        geocoder=_GEOCODER,
    )

    (solve,) = await _queued_solves(db_session, tournament_id)
    assert solve.trigger is ScheduleSolveTrigger.settings_changed
    assert solve.status is ScheduleSolveStatus.queued


async def test_re_wording_a_table_on_a_drawn_tournament_requests_no_solve(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The other side of the same rule: a label and a court are DISPLAY, and the
    catalogue the solver reads is its ids (``_load_solver_inputs`` reduces it to
    ``TableId``s). Re-wording a table leaves that set untouched — the same rows, the
    same ids — so a drawn tournament is not re-solved for a piece of signage.

    This is what positional application buys. Rebuild the catalogue on every PATCH and
    a re-word would mint two fresh ids, which genuinely IS an input change — so the
    board would be re-solved, and every placement pointing at the old ids would have
    dangled first."""
    owner = await make_user(db_session, "owner-reword")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    await _draw_an_event(db_session, tournament)
    table_ids_before = await _catalogue_ids(db_session, tournament_id)

    await db_session.refresh(owner)
    await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(
            table_catalogue=[
                TournamentTableWrite(label="Centre Table", court="A"),
                TournamentTableWrite(label="Table 2", court="A"),
            ]
        ),
        geocoder=_GEOCODER,
    )

    assert await _queued_solves(db_session, tournament_id) == []
    # And the re-word landed on the very rows that were already there.
    assert await _catalogue_ids(db_session, tournament_id) == table_ids_before
    assert await _catalogue_labels(db_session, tournament_id) == [
        "Centre Table",
        "Table 2",
    ]


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
                TournamentTableWrite(label="Table 9", court="C"),
            ]
        ),
        geocoder=_GEOCODER,
    )

    assert await _queued_solves(db_session, tournament_id) == []


async def test_a_shorter_catalogue_removes_the_tables_off_the_end(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A table the director stopped sending is gone from the ``tournament_tables``
    rows, not merely absent from a JSON blob — ``delete-orphan`` on
    ``Tournament.tables`` is what turns dropping it out of the collection into a
    DELETE. The table that stayed keeps the id it already had."""
    owner = await make_user(db_session, "owner-shrink")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id
    first_id, _second_id = await _catalogue_ids(db_session, tournament_id)

    # The catalogue read expired ``owner``; a real request holds a freshly-loaded
    # ``current_user``, so refresh it back before handing it to the verb.
    await db_session.refresh(owner)
    await edit_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        updates=TournamentUpdate(
            table_catalogue=[TournamentTableWrite(label="Table 1", court="A")]
        ),
        geocoder=_GEOCODER,
    )

    assert await _catalogue_ids(db_session, tournament_id) == [first_id]
