"""Owned draw values, SQL integrity, and API compatibility on migrated PostgreSQL."""

import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal, get_args

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    TournamentEvent,
    User,
)
from app.schemas.tournament import (
    DrawSettingsWrite,
    RrThenKoDrawSettingsWrite,
    SingleElimDrawSettingsWrite,
    SwissDrawSettingsWrite,
    draw_settings_from_storage,
)
from app.tournament_draw_settings import draw_settings_of
from app.tournaments import TOURNAMENT_CREATE
from tests._helpers import grant_permissions, patch_event, start_session


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The shared ``api_client`` with a real session whose user holds
    ``tournament.view`` + ``tournament.create`` — the same genuine RBAC rows
    ``test_tournaments`` grants, not a dependency override."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_CREATE,))
    yield api_client, user


def _tournament_payload() -> dict[str, Any]:
    return {
        "name": "Draw Settings Cup",
        "address": {
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        "table_catalogue": [{"label": "Table 1", "court": "A"}],
    }


def _event_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": "round-robin",
        "max_players": 64,
        "entry_fee": 45,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": True, "length_games": 5},
        "predicates": [],
        "reservations": [
            {
                "name": "Reservation A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1"],
            }
        ],
    }
    payload.update(overrides)
    return payload


async def _create_event(
    client: AsyncClient, **overrides: Any
) -> tuple[uuid.UUID, uuid.UUID]:
    """Create a tournament and one event through the API; return both ids."""
    tournament = await client.post("/v1/tournaments", json=_tournament_payload())
    assert tournament.status_code == 201, tournament.text
    tournament_id = tournament.json()["id"]
    event = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=_event_payload(**overrides)
    )
    assert event.status_code == 201, event.text
    return uuid.UUID(tournament_id), uuid.UUID(event.json()["id"])


async def _load_events(
    db: AsyncSession, *event_ids: uuid.UUID
) -> list[TournamentEvent]:
    """Re-read the named events FROM THE DATABASE.

    ``expire_all`` first, and only once for the whole batch: the API client shares
    this session, so without it an assertion could be satisfied by the very
    in-memory objects the request left behind rather than by what was written. (It
    has to be once, not once per event — a second ``expire_all`` would expire the
    rows the first load just populated.)
    """
    db.expire_all()
    loaded = []
    for event_id in event_ids:
        loaded.append(
            (
                await db.execute(
                    select(TournamentEvent).where(TournamentEvent.id == event_id)
                )
            ).scalar_one()
        )
    return loaded


async def test_sql_copied_draw_settings_belong_to_each_event(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    _, first_id = await _create_event(client, draw_type="swiss", rounds=5)
    _, second_id = await _create_event(client, draw_type="round-robin")
    await db_session.execute(
        sa.text("""
            UPDATE tournament_events SET
                (draw_type_id, draw_settings) = (
                    SELECT draw_type_id, draw_settings
                    FROM tournament_events WHERE id = :first
                )
            WHERE id = :second
        """),
        {"first": first_id, "second": second_id},
    )
    await db_session.execute(
        sa.text("""
            UPDATE tournament_events SET draw_settings = '{"rounds": 7}'::jsonb
            WHERE id = :first
        """),
        {"first": first_id},
    )
    await db_session.commit()
    first, second = await _load_events(db_session, first_id, second_id)
    assert draw_settings_of(first.draw_settings) == SwissDrawSettingsWrite(rounds=7)
    assert draw_settings_of(second.draw_settings) == SwissDrawSettingsWrite(rounds=5)


def test_every_draw_type_has_an_arm_in_the_write_union() -> None:
    """Every supported draw type has exactly one type-specific validation arm."""
    arms = get_args(get_args(DrawSettingsWrite)[0])
    discriminators = [arm.model_fields["draw_type"].default for arm in arms]

    assert {discriminator.value for discriminator in discriminators} == {
        draw_type.value for draw_type in DrawType
    }
    # One arm per member, so two arms tagged with the same slug (a copy/paste that
    # leaves a member uncovered while the set above still matches) also reds.
    assert len(discriminators) == len(DrawType)


@pytest.mark.parametrize(
    "draw_type,settings",
    [
        ("round-robin", {}),
        ("single-elim", {}),
        ("rr-then-ko", {"qualifiers_per_group": 2}),
        ("swiss", {"rounds": 5}),
    ],
)
async def test_event_draw_configuration_round_trips(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    draw_type: str,
    settings: dict[str, Any],
) -> None:
    client, _ = authed_client
    tournament_id, event_id = await _create_event(
        client, draw_type=draw_type, **settings
    )
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    event_read = next(e for e in response.json()["events"] if e["id"] == str(event_id))
    assert event_read["draw_type"] == draw_type
    for key, value in settings.items():
        assert event_read[key] == value
    (event,) = await _load_events(db_session, event_id)
    assert draw_settings_of(event.draw_settings) == draw_settings_from_storage(
        DrawType(draw_type), settings
    )


async def test_editing_one_events_settings_leaves_the_other_unchanged(
    authed_client: tuple[AsyncClient, User],
) -> None:
    client, _ = authed_client
    tournament_id, first_id = await _create_event(client, draw_type="swiss", rounds=5)
    second = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(name="Second Singles", draw_type="swiss", rounds=5),
    )
    assert second.status_code == 201, second.text
    response = await patch_event(
        client, tournament_id, first_id, {"draw_type": "swiss", "rounds": 7}
    )
    assert response.status_code == 200, response.text
    assert response.json()["rounds"] == 7
    other = await client.get(f"/v1/tournaments/{tournament_id}")
    assert other.status_code == 200, other.text
    other_event = next(
        e for e in other.json()["events"] if e["id"] == second.json()["id"]
    )
    assert other_event["draw_type"] == "swiss"
    assert other_event["rounds"] == 5


async def test_changing_draw_type_discards_the_previous_types_settings(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    tournament_id, event_id = await _create_event(client, draw_type="swiss", rounds=5)
    response = await patch_event(
        client, tournament_id, event_id, {"draw_type": "single-elim"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["draw_type"] == "single-elim"
    assert response.json()["rounds"] is None
    (event,) = await _load_events(db_session, event_id)
    assert draw_settings_of(event.draw_settings) == SingleElimDrawSettingsWrite()


async def test_renaming_an_event_preserves_its_draw_configuration(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    tournament_id, event_id = await _create_event(client, draw_type="swiss", rounds=5)
    response = await patch_event(
        client, tournament_id, event_id, {"name": "Renamed Singles"}
    )
    assert response.status_code == 200, response.text
    (event,) = await _load_events(db_session, event_id)
    assert event.name == "Renamed Singles"
    assert draw_settings_of(event.draw_settings) == SwissDrawSettingsWrite(rounds=5)


@pytest.mark.parametrize("parent", ["event", "tournament"])
@pytest.mark.parametrize("writer", ["sql", "api"])
async def test_deleting_the_owner_leaves_no_draw_configuration(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    parent: Literal["event", "tournament"],
    writer: Literal["sql", "api"],
) -> None:
    client, _ = authed_client
    tournament_id, event_id = await _create_event(client, draw_type="swiss", rounds=5)
    second = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(name="Second Singles", draw_type="single-elim"),
    )
    assert second.status_code == 201, second.text
    second_id = uuid.UUID(second.json()["id"])
    _, survivor_id = await _create_event(client, draw_type="swiss", rounds=7)
    if writer == "sql":
        table = "tournament_events" if parent == "event" else "tournaments"
        owner_id = event_id if parent == "event" else tournament_id
        await db_session.execute(
            sa.text(f"DELETE FROM {table} WHERE id = :id"), {"id": owner_id}
        )
        await db_session.commit()
    else:
        path = f"/v1/tournaments/{tournament_id}"
        if parent == "event":
            path += f"/events/{event_id}"
        response = await client.delete(path)
        assert response.status_code == 204, response.text
    assert (
        await db_session.scalar(
            sa.text("SELECT count(*) FROM tournament_events WHERE id = :id"),
            {"id": event_id},
        )
        == 0
    )
    assert await db_session.scalar(
        sa.text("SELECT count(*) FROM tournament_events WHERE id = :id"),
        {"id": second_id},
    ) == (1 if parent == "event" else 0)
    # No independent storage can survive an event, regardless of deletion path.
    assert (
        await db_session.scalar(
            sa.text("SELECT to_regclass('tournament_event_draw_settings')")
        )
        is None
    )
    (survivor,) = await _load_events(db_session, survivor_id)
    assert draw_settings_of(survivor.draw_settings) == SwissDrawSettingsWrite(rounds=7)


@pytest.mark.parametrize(
    "value",
    [
        "'[]'::jsonb",
        "'1'::jsonb",
        "'true'::jsonb",
        "'\"nope\"'::jsonb",
        "'null'::jsonb",
        "NULL",
    ],
)
async def test_sql_rejects_settings_that_are_not_an_object(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession, value: str
) -> None:
    client, _ = authed_client
    _, event_id = await _create_event(client)
    constraint = (
        "not-null" if value == "NULL" else "ck_tournament_events_draw_settings_object"
    )
    with pytest.raises(IntegrityError, match=constraint):
        async with db_session.begin_nested():
            await db_session.execute(
                sa.text(
                    f"UPDATE tournament_events SET draw_settings = {value} "
                    "WHERE id = :id"
                ),
                {"id": event_id},
            )


@pytest.mark.parametrize("draw_type_id", [None, uuid.uuid4()])
async def test_sql_requires_a_seeded_draw_type(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    draw_type_id: uuid.UUID | None,
) -> None:
    client, _ = authed_client
    _, event_id = await _create_event(client)
    constraint = (
        "not-null" if draw_type_id is None else "tournament_events_draw_type_id_fkey"
    )
    with pytest.raises(IntegrityError, match=constraint):
        async with db_session.begin_nested():
            await db_session.execute(
                sa.text(
                    "UPDATE tournament_events SET draw_type_id = :draw_type "
                    "WHERE id = :id"
                ),
                {"draw_type": draw_type_id, "id": event_id},
            )


async def test_type_specific_validation_remains_in_the_backend(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    tournament_id, event_id = await _create_event(
        client, draw_type="rr-then-ko", qualifiers_per_group=2
    )
    for settings in ({"qualifiers_per_group": 0}, {"qualifiers_per_group": -1}, {}):
        with pytest.raises(ValidationError, match="qualifiers_per_group"):
            draw_settings_from_storage(DrawType.rr_then_ko, settings)
    assert draw_settings_from_storage(
        DrawType.rr_then_ko, {"qualifiers_per_group": 1}
    ) == RrThenKoDrawSettingsWrite(qualifiers_per_group=1)
    response = await patch_event(
        client,
        tournament_id,
        event_id,
        {"draw_type": "rr-then-ko", "qualifiers_per_group": 0},
    )
    assert response.status_code == 422, response.text
    stored = await db_session.scalar(
        sa.text(
            "UPDATE tournament_events SET draw_settings = "
            "'{\"qualifiers_per_group\": 0}'::jsonb "
            "WHERE id = :id RETURNING draw_settings"
        ),
        {"id": event_id},
    )
    assert stored == {"qualifiers_per_group": 0}


async def test_a_seeded_draw_type_cannot_be_deleted_while_an_event_uses_it(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    _, event_id = await _create_event(client)
    # Isolate the event FK from the stage FK which independently protects the type.
    await db_session.execute(
        sa.text("DELETE FROM tournament_event_stages WHERE event_id = :id"),
        {"id": event_id},
    )
    with pytest.raises(IntegrityError, match="tournament_events_draw_type_id_fkey"):
        async with db_session.begin_nested():
            await db_session.execute(
                sa.text("DELETE FROM draw_types WHERE key = 'round-robin'")
            )
