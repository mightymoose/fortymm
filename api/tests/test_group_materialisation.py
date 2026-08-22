"""The server materialises an event's group rows, maps them round-robin onto its
reservations, and freezes the set at the cut (#1387, ADR 20260822).

Everything here is driven through the real routes: the two event write verbs (a create
and a patch reach the same rule), the cut, the un-cut and the freeze. The derivation
itself is pure and pinned from literals in ``test_draw_structure.py``; what this file
tests is that the rows FOLLOW it — against the preview field on an event write, against
the real registered field at the cut — and that nothing moves them once a draw exists.

The one pure test is the boundary one: for any real field of two or more entrants,
``ceil(N / 5)`` groups over ``N`` entrants leave no group of one, so the snake's own
refusal is unreachable from the derived count alone.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draw_structure import DEFAULT_GROUP_SIZE
from app.models import (
    DrawType,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEventStageGroup,
    TournamentFixture,
    User,
)
from app.schedule_preview import DEFAULT_UNCAPPED_FIELD
from app.tournament_queries import stage_ids_for_events
from app.tournament_reservations import group_count_for
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import grant_permissions, make_user, start_session

RR_THEN_KO = DrawType.rr_then_ko.value


def _reservation(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
        "table_ids": [],
    }


RESERVATION_A = _reservation("Reservation A")
RESERVATION_B = _reservation("Reservation B")
RESERVATION_C = _reservation("Reservation C")
RESERVATION_D = _reservation("Reservation D")


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))
    yield api_client, user


def _event_payload(**overrides: Any) -> dict[str, Any]:
    """An ``rr-then-ko`` event with a 40-player cap over one reservation — the
    out-of-the-box shape #1387's acceptance criteria are written against: 8 groups,
    1 reservation."""
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": RR_THEN_KO,
        "qualifiers_per_group": 1,
        "max_players": 40,
        "entry_fee": 0,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": False, "length_games": 3},
        "predicates": [],
        "reservations": [RESERVATION_A],
    }
    payload.update(overrides)
    return payload


async def _tournament(client: AsyncClient) -> str:
    created = await client.post(
        "/v1/tournaments",
        json={
            "name": "Materialisation Open",
            "address": {
                "venue": "Berkeley TT Club",
                "street": "2727 Milvia St",
                "city": "Berkeley",
                "region": "CA",
                "postal": "94703",
                "country": "USA",
            },
            "table_catalogue": [{"label": "Table 1", "court": "A"}],
        },
    )
    assert created.status_code == 201, created.text
    tournament_id: str = created.json()["id"]
    return tournament_id


async def _create_event(
    client: AsyncClient, tournament_id: str, **overrides: Any
) -> dict[str, Any]:
    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=_event_payload(**overrides)
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def _create_other(
    client: AsyncClient, tournament_id: str, draw_type: str, **overrides: Any
) -> dict[str, Any]:
    """An event of one of the three draw types that carry no qualifier count."""
    payload = _event_payload(draw_type=draw_type, **overrides)
    del payload["qualifiers_per_group"]
    if draw_type == "swiss":
        payload["rounds"] = 5
    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=payload
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def _patch(
    client: AsyncClient, tournament_id: str, event_id: str, **updates: Any
) -> Any:
    return await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}", json=updates
    )


def _draw_url(tournament_id: str, event_id: str) -> str:
    return f"/v1/tournaments/{tournament_id}/events/{event_id}/draw"


async def _seed_field(
    db: AsyncSession, event_id: str, count: int, *, prefix: str = "p", start: int = 1
) -> list[TournamentEntry]:
    """``count`` active entries, seeded from ``start`` with staggered registration
    times, so the group each one snakes into is a fact of the fixture."""
    entries = []
    for seed in range(start, start + count):
        user = await make_user(db, f"{prefix}-{event_id[:8]}-{seed}")
        entry = TournamentEntry(
            event_id=uuid.UUID(event_id),
            user_id=user.id,
            status=TournamentEntryStatus.entered,
            seed=seed,
            created_at=datetime(2026, 6, 1, 9, 0, tzinfo=UTC) + timedelta(minutes=seed),
        )
        db.add(entry)
        entries.append(entry)
    await db.commit()
    return entries


def _cited(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The event's reservations as a PATCH must cite them: id + the write fields."""
    return [
        {
            "id": reservation["id"],
            "name": reservation["name"],
            "slot": reservation["slot"],
            "table_ids": reservation["table_ids"],
        }
        for reservation in body["reservations"]
    ]


def _groups(body: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(body["groups"], key=lambda group: group["position"])


def _mapping(body: dict[str, Any]) -> list[str | None]:
    """Each group's ``reservation_id``, in position order."""
    return [group["reservation_id"] for group in _groups(body)]


def _expected_mapping(body: dict[str, Any]) -> list[str | None]:
    """The ``position % reservation count`` rule, spelled against the response."""
    reservations = sorted(body["reservations"], key=lambda row: row["position"])
    if not reservations:
        return [None for _ in body["groups"]]
    return [
        reservations[group["position"] % len(reservations)]["id"]
        for group in _groups(body)
    ]


async def _stored_group_ids(db: AsyncSession, event_id: str) -> list[uuid.UUID]:
    return list(
        (
            await db.execute(
                select(TournamentEventStageGroup.id)
                .where(
                    TournamentEventStageGroup.stage_id.in_(
                        stage_ids_for_events([uuid.UUID(event_id)])
                    )
                )
                .order_by(TournamentEventStageGroup.position)
            )
        )
        .scalars()
        .all()
    )


async def _fixtures(db: AsyncSession, event_id: str) -> list[TournamentFixture]:
    db.expire_all()
    return list(
        (
            await db.execute(
                select(TournamentFixture)
                .where(
                    TournamentFixture.stage_id.in_(
                        stage_ids_for_events([uuid.UUID(event_id)])
                    )
                )
                .order_by(
                    TournamentFixture.group_id.asc().nulls_last(),
                    TournamentFixture.round,
                    TournamentFixture.position,
                )
            )
        )
        .scalars()
        .all()
    )


def _group_sizes(fixtures: list[TournamentFixture]) -> list[int]:
    """How many entrants each group's fixtures seat, in group order."""
    seats: dict[uuid.UUID, set[uuid.UUID]] = {}
    for fixture in fixtures:
        if fixture.group_id is None:
            continue
        for entry_id in (fixture.entry_a_id, fixture.entry_b_id):
            if entry_id is not None:
                seats.setdefault(fixture.group_id, set()).add(entry_id)
    return [len(entries) for entries in seats.values()]


def _snapshot(fixtures: list[TournamentFixture]) -> list[tuple[Any, ...]]:
    return [
        (f.id, f.group_id, f.round, f.position, f.entry_a_id, f.entry_b_id)
        for f in fixtures
    ]


async def _read(client: AsyncClient, tournament_id: str, event_id: str) -> Any:
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    (event,) = [e for e in response.json()["events"] if e["id"] == event_id]
    return event


# ----- the rows, before the cut ----------------------------------------------------


async def test_an_rr_then_ko_create_materialises_groups_from_the_preview_field(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The out-of-the-box shape: one reservation and a 40-player cap hold 8 groups and
    1 reservation. A group count creates no reservation, and every group maps onto
    the one reservation there is."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    event = await _create_event(client, tournament_id)

    assert len(event["groups"]) == 8
    assert len(event["reservations"]) == 1
    assert [group["position"] for group in _groups(event)] == list(range(8))
    assert _mapping(event) == [event["reservations"][0]["id"]] * 8


async def test_eight_groups_across_four_reservations_map_two_to_each(
    authed_client: tuple[AsyncClient, User],
) -> None:
    client, _ = authed_client
    tournament_id = await _tournament(client)

    event = await _create_event(
        client,
        tournament_id,
        reservations=[RESERVATION_A, RESERVATION_B, RESERVATION_C, RESERVATION_D],
    )

    assert len(event["groups"]) == 8
    assert _mapping(event) == _expected_mapping(event)
    by_reservation = {
        reservation["id"]: _mapping(event).count(reservation["id"])
        for reservation in event["reservations"]
    }
    assert set(by_reservation.values()) == {2}


async def test_a_group_on_an_event_with_no_reservation_carries_a_null_reservation_id(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """A director sets structure before booking: the groups exist, each with no
    reservation, and the wire says so with ``null`` rather than dropping the group."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    event = await _create_event(client, tournament_id, reservations=[])

    assert len(event["groups"]) == 8
    assert event["reservations"] == []
    assert _mapping(event) == [None] * 8


async def test_lowering_the_cap_removes_group_rows_and_keeps_the_lowest_positions(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """A patch carrying only ``max_players`` reaches the rule (the materialisation is
    unconditional, not gated on a ``reservations`` key), writes no reservation change,
    and drops the TAIL: positions 0 and 1 keep their ids."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)
    before = await _stored_group_ids(db_session, event["id"])
    assert len(before) == 8

    response = await _patch(client, tournament_id, event["id"], max_players=10)

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["groups"]) == 2
    assert body["reservations"] == event["reservations"]
    assert await _stored_group_ids(db_session, event["id"]) == before[:2]
    assert _mapping(body) == _expected_mapping(body)


async def test_clearing_the_cap_derives_against_the_uncapped_default(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """Planning's correction: an explicit ``null`` clears the cap (ADR-0935), so a
    40-cap event holding 8 groups drops to the 4 the 16 fallback derives."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)

    response = await _patch(client, tournament_id, event["id"], max_players=None)

    assert response.status_code == 200, response.text
    assert response.json()["max_players"] is None
    assert len(response.json()["groups"]) == -(-DEFAULT_UNCAPPED_FIELD // 5) == 4


@pytest.mark.parametrize("draw_type", ["round-robin", "single-elim", "swiss"])
async def test_every_other_draw_type_keeps_one_group_per_reservation(
    authed_client: tuple[AsyncClient, User], draw_type: str
) -> None:
    """Decision 2: the derivation covers ``rr-then-ko`` only. A 40-cap round-robin over
    three reservations is three groups, not eight, and a cap change moves nothing."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_other(
        client,
        tournament_id,
        draw_type,
        reservations=[RESERVATION_A, RESERVATION_B, RESERVATION_C],
    )
    assert len(event["groups"]) == 3
    assert _mapping(event) == _expected_mapping(event)

    response = await _patch(client, tournament_id, event["id"], max_players=10)

    assert response.status_code == 200, response.text
    assert len(response.json()["groups"]) == 3


async def test_patching_the_draw_type_to_and_from_rr_then_ko_moves_the_rows(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The materialisation runs AFTER ``store_draw_settings``, so a patch TO
    ``rr-then-ko`` reads the new type and materialises; a patch away returns the event
    to one group per reservation."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_other(
        client,
        tournament_id,
        "round-robin",
        reservations=[RESERVATION_A, RESERVATION_B, RESERVATION_C],
    )
    assert len(event["groups"]) == 3
    kept = await _stored_group_ids(db_session, event["id"])

    to_rrko = await _patch(
        client,
        tournament_id,
        event["id"],
        draw_type=RR_THEN_KO,
        qualifiers_per_group=1,
    )
    assert to_rrko.status_code == 200, to_rrko.text
    assert len(to_rrko.json()["groups"]) == 8
    assert _mapping(to_rrko.json()) == _expected_mapping(to_rrko.json())
    # A grow keeps the rows the event had, and appends.
    assert (await _stored_group_ids(db_session, event["id"]))[:3] == kept

    back = await _patch(client, tournament_id, event["id"], draw_type="round-robin")
    assert back.status_code == 200, back.text
    assert len(back.json()["groups"]) == 3
    assert await _stored_group_ids(db_session, event["id"]) == kept


async def test_the_mapping_recomputes_on_a_reservations_patch_while_no_draw_exists(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Adding a second reservation re-maps the odd positions onto it; the group rows
    themselves are untouched (same ids, same count), because a group count never
    reads the reservation count."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)
    before = await _stored_group_ids(db_session, event["id"])

    response = await _patch(
        client,
        tournament_id,
        event["id"],
        reservations=[*_cited(event), RESERVATION_B],
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["reservations"]) == 2
    assert await _stored_group_ids(db_session, event["id"]) == before
    assert _mapping(body) == _expected_mapping(body)
    assert len(set(_mapping(body))) == 2


# ----- the cut ---------------------------------------------------------------------


async def test_the_cut_re_derives_the_count_from_the_real_field(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """A 40-player cap with 10 registrants cuts into 2 groups of 5 — not the 8 the
    preview field materialised — and the 6 tail rows are gone."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)
    assert len(event["groups"]) == 8
    before = await _stored_group_ids(db_session, event["id"])
    await _seed_field(db_session, event["id"], 10)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 201, response.text
    assert await _stored_group_ids(db_session, event["id"]) == before[:2]
    assert sorted(_group_sizes(await _fixtures(db_session, event["id"]))) == [5, 5]
    read = await _read(client, tournament_id, event["id"])
    assert _mapping(read) == _expected_mapping(read)


async def test_an_uncapped_event_with_five_registrants_cuts_into_one_group(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The table in #1387's discovery: the out-of-the-box event, which #1370 as written
    would have refused as ``DegenerateDraw`` (four groups of 2, 1, 1, 1).

    Two qualifiers, not one: a single group taking one qualifier is a knockout of one,
    which the strategy refuses (the ticket's "one group taking one qualifier" edge
    case, unchanged here) — and the refusal's copy already tells the director to take
    more."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(
        client, tournament_id, max_players=None, qualifiers_per_group=2
    )
    assert len(event["groups"]) == 4
    await _seed_field(db_session, event["id"], 5)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 201, response.text
    assert len(await _stored_group_ids(db_session, event["id"])) == 1
    assert _group_sizes(await _fixtures(db_session, event["id"])) == [5]


@pytest.mark.parametrize("field", [2, 3, 6, 11])
def test_no_derived_group_holds_fewer_than_two_for_any_field_of_two_or_more(
    field: int,
) -> None:
    """The arithmetic the cut leans on, at the boundary values planning named:
    ``ceil(N / 5)`` groups over ``N`` entrants give a smallest group of
    ``floor(N / ceil(N / 5))``, which is 2 or more for every ``N`` of 2 or more — so
    ``_snake``'s refusal is unreachable from the derived count alone."""
    count = group_count_for(DrawType.rr_then_ko, field_size=field, reservation_count=0)
    assert count == -(-field // DEFAULT_GROUP_SIZE)
    assert field // count >= 2


@pytest.mark.parametrize("field", [2, 3, 6, 11])
async def test_the_cut_succeeds_at_every_boundary_field(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession, field: int
) -> None:
    client, _ = authed_client
    tournament_id = await _tournament(client)
    # Two qualifiers: the fields of 2 and 3 derive one group, and one group taking
    # one qualifier is the knockout-of-one refusal, not the snake's.
    event = await _create_event(
        client, tournament_id, max_players=None, qualifiers_per_group=2
    )
    await _seed_field(db_session, event["id"], field)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 201, response.text
    assert min(_group_sizes(await _fixtures(db_session, event["id"]))) >= 2


async def test_a_single_entrant_still_answers_degenerate_draw(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)
    await _seed_field(db_session, event["id"], 1)

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 422, response.text
    assert "1 entrant across 1 group" in response.json()["detail"]


async def test_a_re_cut_re_derives_and_an_uncut_keeps_the_cut_time_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The intended oscillation: cut at 2 groups from 10 registrants, re-cut at 3 once
    four more register (the two rows survive), uncut (writes no group row — the count
    stays 3), then any event write returns the event to the 8 the cap derives, and
    the next cut to 3 again."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)
    await _seed_field(db_session, event["id"], 10)
    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201
    two = await _stored_group_ids(db_session, event["id"])
    assert len(two) == 2

    await _seed_field(db_session, event["id"], 4, prefix="late", start=11)
    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201
    three = await _stored_group_ids(db_session, event["id"])
    assert len(three) == 3
    assert three[:2] == two

    uncut = await client.delete(_draw_url(tournament_id, event["id"]))
    assert uncut.status_code == 204, uncut.text
    assert await _stored_group_ids(db_session, event["id"]) == three

    renamed = await _patch(client, tournament_id, event["id"], name="Renamed")
    assert renamed.status_code == 200, renamed.text
    assert len(renamed.json()["groups"]) == 8
    assert (await _stored_group_ids(db_session, event["id"]))[:3] == three

    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201
    assert await _stored_group_ids(db_session, event["id"]) == three


async def test_a_refused_re_cut_that_moves_the_count_leaves_the_standing_draw_untouched(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Planning's answer to the re-cut ordering question. When the derived count moves
    on a re-cut, ``cut_draw`` has to delete the old fixtures before it can drop a
    group row, so the plan-before-delete ordering cannot hold and the transaction
    rollback is the only lock. This test is what pins that lock.

    Ten registrants, top one per group: two groups, a final of two. Five withdraw, so
    the re-cut derives ONE group — the count moves, the branch under test runs — and
    one group taking one qualifier is a knockout of one, which the strategy refuses.
    The draw the event had must still be there, row for row, and so must its two
    group rows.

    **Falsification** (``.claude/rules/verify-the-artifact-under-test.md``): add an
    ``await db.commit()`` after the ``uncut_draw`` inside ``cut_draw``'s moving-count
    branch, and this test reds on the fixtures assertion — the old draw is gone and
    nothing replaced it. Confirmed directly.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)
    entries = await _seed_field(db_session, event["id"], 10)
    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201
    groups_before = await _stored_group_ids(db_session, event["id"])
    assert len(groups_before) == 2
    fixtures_before = _snapshot(await _fixtures(db_session, event["id"]))
    assert fixtures_before

    for entry in entries[5:]:
        entry.status = TournamentEntryStatus.withdrawn
    await db_session.commit()

    response = await client.post(_draw_url(tournament_id, event["id"]))

    assert response.status_code == 422, response.text
    assert "knockout" in response.json()["detail"]
    assert _snapshot(await _fixtures(db_session, event["id"])) == fixtures_before
    assert await _stored_group_ids(db_session, event["id"]) == groups_before


async def test_the_409s_way_out_works_end_to_end(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Remove the draw, add a reservation, and that write re-materialises the groups
    (and re-maps them onto both reservations) before the next cut."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(client, tournament_id)
    await _seed_field(db_session, event["id"], 10)
    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201

    refused = await _patch(
        client,
        tournament_id,
        event["id"],
        reservations=[*_cited(event), RESERVATION_B],
    )
    assert refused.status_code == 409, refused.text

    assert (
        await client.delete(_draw_url(tournament_id, event["id"]))
    ).status_code == 204
    added = await _patch(
        client,
        tournament_id,
        event["id"],
        reservations=[*_cited(event), RESERVATION_B],
    )
    assert added.status_code == 200, added.text
    assert len(added.json()["groups"]) == 8
    assert len(set(_mapping(added.json()))) == 2

    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201
    read = await _read(client, tournament_id, event["id"])
    assert len(read["groups"]) == 2
    assert _mapping(read) == _expected_mapping(read)
    assert len(set(_mapping(read))) == 2


# ----- the freeze ------------------------------------------------------------------


async def _cut_event(
    client: AsyncClient, db_session: AsyncSession
) -> tuple[str, dict[str, Any]]:
    """A 40-cap event over two reservations, cut at 10 registrants: two groups, one on
    each reservation."""
    tournament_id = await _tournament(client)
    event = await _create_event(
        client, tournament_id, reservations=[RESERVATION_A, RESERVATION_B]
    )
    await _seed_field(db_session, event["id"], 10)
    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201
    return tournament_id, await _read(client, tournament_id, event["id"])


async def test_adding_a_reservation_to_a_cut_event_is_refused_and_says_why(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    tournament_id, event = await _cut_event(client, db_session)

    response = await _patch(
        client,
        tournament_id,
        event["id"],
        reservations=[*_cited(event), RESERVATION_C],
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "1 new reservation could hold no group" in detail
    assert "A reservation's tables, its time and its name can all still be changed" in (
        detail
    )
    assert "remove the draw first" in detail


async def test_removing_a_reservation_from_a_cut_event_names_the_groups_it_strands(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    tournament_id, event = await _cut_event(client, db_session)

    response = await _patch(
        client, tournament_id, event["id"], reservations=_cited(event)[:1]
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "“Group B” already has fixtures drawn into it" in detail
    assert "Group A" not in detail


async def test_removing_a_reservation_no_group_maps_onto_is_still_refused(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """One group across two reservations: the second holds no group, and removing it
    strands nothing — and is refused all the same, with a clause in the sentence."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event = await _create_event(
        client,
        tournament_id,
        reservations=[RESERVATION_A, RESERVATION_B],
        qualifiers_per_group=2,
    )
    await _seed_field(db_session, event["id"], 5)
    assert (await client.post(_draw_url(tournament_id, event["id"]))).status_code == 201
    event = await _read(client, tournament_id, event["id"])
    assert len(event["groups"]) == 1

    response = await _patch(
        client, tournament_id, event["id"], reservations=_cited(event)[:1]
    )

    assert response.status_code == 409, response.text
    assert "1 reservation would be removed" in response.json()["detail"]


async def test_a_cap_change_on_a_cut_event_succeeds_and_moves_no_group(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Decision 5: the count no longer reads the cap once a draw exists. 40 to 100 to
    6, and the two groups stay exactly the two groups."""
    client, _ = authed_client
    tournament_id, event = await _cut_event(client, db_session)
    before = await _stored_group_ids(db_session, event["id"])

    for cap in (100, 6):
        response = await _patch(client, tournament_id, event["id"], max_players=cap)
        assert response.status_code == 200, response.text
        assert _mapping(response.json()) == _mapping(event)
        assert await _stored_group_ids(db_session, event["id"]) == before


async def test_a_rename_and_a_reservation_edit_on_a_cut_event_succeed(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    client, _ = authed_client
    tournament_id, event = await _cut_event(client, db_session)
    before = await _stored_group_ids(db_session, event["id"])

    renamed = await _patch(client, tournament_id, event["id"], name="Renamed")
    assert renamed.status_code == 200, renamed.text

    cited = _cited(event)
    cited[0]["name"] = "Morning session"
    cited[0]["slot"] = {"date": "2026-06-13", "start": "10:00", "end": "13:00"}
    edited = await _patch(client, tournament_id, event["id"], reservations=cited)
    assert edited.status_code == 200, edited.text
    assert edited.json()["reservations"][0]["name"] == "Morning session"
    assert edited.json()["reservations"][0]["slot"]["start"] == "10:00"
    assert await _stored_group_ids(db_session, event["id"]) == before
    assert _mapping(edited.json()) == _mapping(event)
