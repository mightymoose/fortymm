"""Concurrent editor behavior through the tournament HTTP interface."""

import jsonschema
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User
from tests._helpers import start_session
from tests.test_tournaments import _create_payload, _grant_tournament_perms


@pytest_asyncio.fixture
async def editor_client(api_client: AsyncClient, db_session: AsyncSession):
    user = await start_session(api_client, db_session)
    await _grant_tournament_perms(db_session, user)
    return api_client, user


async def test_stale_details_save_preserves_the_other_tabs_venue(
    editor_client: tuple[AsyncClient, User],
):
    client, _ = editor_client
    created = await client.post("/v1/tournaments", json=_create_payload())
    tournament = created.json()
    url = f"/v1/tournaments/{tournament['id']}"
    first = await client.patch(
        url,
        json={
            "details_version": 1,
            "address": {**_create_payload()["address"], "venue": "Tab A Venue"},
        },
    )
    assert first.status_code == 200, first.text
    stale = await client.patch(
        url,
        json={
            "details_version": 1,
            "name": "Stale name",
            "address": {**_create_payload()["address"], "region": "NY"},
        },
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "tournament_details_version_conflict"
    openapi = (await client.get("/openapi.json")).json()
    response_schema = openapi["paths"]["/v1/tournaments/{tournament_id}"]["patch"][
        "responses"
    ]["409"]["content"]["application/json"]["schema"]
    jsonschema.validate(
        stale.json(), {**response_schema, "components": openapi["components"]}
    )

    current = (await client.get(url)).json()
    assert current["address"]["venue"] == "Tab A Venue"
    assert current["address"]["region"] == "CA"
    assert current["name"] == tournament["name"]
    assert current["details_version"] == 2


async def test_details_and_separate_events_have_independent_save_versions(
    editor_client: tuple[AsyncClient, User],
):
    from tests.test_tournaments import _event_payload

    client, _ = editor_client
    tournament = (await client.post("/v1/tournaments", json=_create_payload())).json()
    url = f"/v1/tournaments/{tournament['id']}"
    event_a = (await client.post(f"{url}/events", json=_event_payload())).json()
    event_b = (
        await client.post(f"{url}/events", json=_event_payload(name="Second event"))
    ).json()
    saved_a = await client.patch(
        f"{url}/events/{event_a['id']}",
        json={"lock_version": event_a["lock_version"], "name": "A saved"},
    )
    assert saved_a.status_code == 200
    details = await client.patch(
        url,
        json={
            "details_version": tournament["details_version"],
            "description": "Details saved",
        },
    )
    assert details.status_code == 200
    saved_b = await client.patch(
        f"{url}/events/{event_b['id']}",
        json={"lock_version": event_b["lock_version"], "name": "B saved"},
    )
    assert saved_b.status_code == 200
    latest = (await client.get(url)).json()
    assert latest["description"] == "Details saved"
    assert latest["details_version"] == details.json()["details_version"]
    assert [event["name"] for event in latest["events"]] == ["A saved", "B saved"]


async def test_details_save_cannot_bypass_conflicts_by_omitting_the_version(
    editor_client: tuple[AsyncClient, User],
):
    client, _ = editor_client
    tournament = (await client.post("/v1/tournaments", json=_create_payload())).json()
    url = f"/v1/tournaments/{tournament['id']}"
    refused = await client.patch(url, json={"address": None})
    assert refused.status_code == 409
    latest = (await client.get(url)).json()
    assert latest["address"] == tournament["address"]


async def test_stale_details_report_conflict_before_a_venue_resolution_error(
    editor_client: tuple[AsyncClient, User],
):
    client, _ = editor_client
    tournament = (await client.post("/v1/tournaments", json=_create_payload())).json()
    url = f"/v1/tournaments/{tournament['id']}"
    assert (
        await client.patch(url, json={"details_version": 1, "name": "New name"})
    ).status_code == 200
    refused = await client.patch(
        url,
        json={
            "details_version": 1,
            "address": {**_create_payload()["address"], "venue": "__unresolvable__"},
        },
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "tournament_details_version_conflict"


async def test_stale_event_cannot_restore_windows_or_other_reservation_names(
    editor_client: tuple[AsyncClient, User],
):
    from tests.test_tournaments import _event_payload

    client, _ = editor_client
    tournament = (await client.post("/v1/tournaments", json=_create_payload())).json()
    url = f"/v1/tournaments/{tournament['id']}"
    slot = {"date": "2026-06-13", "start": "09:00", "end": "13:00"}
    reservations = [
        {"name": f"Reservation {i}", "slot": slot, "table_ids": []} for i in range(3)
    ]
    created = await client.post(
        f"{url}/events",
        json=_event_payload(
            draw_type="rr-then-ko",
            qualifiers_per_group=2,
            slot=slot,
            reservations=reservations,
        ),
    )
    assert created.status_code == 201, created.text
    event = created.json()
    event_url = f"{url}/events/{event['id']}"
    original = [
        {key: r[key] for key in ("id", "name", "slot", "table_ids")}
        for r in event["reservations"]
    ]
    shorter = {**slot, "end": "11:00"}
    current_reservations = [{**r, "slot": shorter} for r in original]
    current_reservations[0]["name"] = "First tab name"
    saved = await client.patch(
        event_url,
        json={
            "lock_version": event["lock_version"],
            "slot": shorter,
            "reservations": current_reservations,
        },
    )
    assert saved.status_code == 200, saved.text
    original[1]["name"] = "Stale second tab name"
    stale = await client.patch(
        event_url,
        json={
            "lock_version": event["lock_version"],
            "name": "Stale event rename",
            "slot": slot,
            "reservations": original,
        },
    )
    assert stale.status_code == 409, stale.text
    current = (await client.get(url)).json()["events"][0]
    assert current["slot"] == shorter
    assert current["name"] == event["name"]
    assert [r["name"] for r in current["reservations"]] == [
        "First tab name",
        "Reservation 1",
        "Reservation 2",
    ]
    assert all(r["slot"] == shorter for r in current["reservations"])


async def test_details_recheck_a_save_that_lands_during_geocoding(
    editor_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine,
):
    import uuid

    import pytest
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.geocoding import FakeGeocoder
    from app.models import Tournament
    from app.schemas.tournament import TournamentUpdate
    from app.tournament_edit import edit_tournament
    from app.tournament_errors import TournamentDetailsVersionConflictError

    client, actor = editor_client
    tournament = (await client.post("/v1/tournaments", json=_create_payload())).json()
    tournament_id = uuid.UUID(tournament["id"])
    # A caller may already hold the earlier read in its session.
    cached = await db_session.get(Tournament, tournament_id)
    assert cached is not None

    class RacingGeocoder:
        async def geocode(self, query):
            async with async_sessionmaker(engine, expire_on_commit=False)() as other:
                await edit_tournament(
                    other,
                    tournament_id=tournament_id,
                    actor=actor,
                    updates=TournamentUpdate(
                        details_version=1, name="Saved during lookup"
                    ),
                    geocoder=FakeGeocoder(),
                )
            return await FakeGeocoder().geocode(query)

    with pytest.raises(TournamentDetailsVersionConflictError):
        await edit_tournament(
            db_session,
            tournament_id=tournament_id,
            actor=actor,
            updates=TournamentUpdate.model_validate(
                {
                    "details_version": 1,
                    "address": {**_create_payload()["address"], "region": "NY"},
                }
            ),
            geocoder=RacingGeocoder(),
        )
    await db_session.rollback()
    latest = (await client.get(f"/v1/tournaments/{tournament_id}")).json()
    assert latest["name"] == "Saved during lookup"
    assert latest["address"]["region"] == "CA"
