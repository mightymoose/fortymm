"""The draw read path's **order**: ``app.tournament_queries.fixtures_by_event``.

A draw has one order, and the loader is where it is decided (in SQL, because a NULL
``group_id`` is not comparable to anything in Python). What that order sorts groups by
is the subject here: the group's ``position`` in its event's own group order — the
server-stamped, 0-based field groups carry (ADR 20260801, "Groups carry an explicit
``position``") — and *not* the group's id.

The distinction is not academic and is not about the future. Group ids were
client-minted strings, ``p-1-…``, ``p-2-…``, ``p-10-…``, and lexicographically ``p-10-``
falls between ``p-1-`` and ``p-2-``: an event with ten or more groups rendered its draw
as group 1, group 10, group 2, group 3, … They are server-minted uuids now
(ADR 20260801), which
does not fix it — it makes it *worse*, because a uuid sort is not merely a different
order, it is a random one. Every test below is written to fail against an id sort, and
each asserts up front that the two orders really do disagree, so a run where the random
ids happened to sort into the director's order cannot pass by luck.

These go through the database, because the ordering *is* the query — asserting it
against anything else would be asserting about a different artifact.
"""

import uuid
from decimal import Decimal
from typing import Any

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventStageGroup,
    TournamentFixture,
    TournamentStatus,
)
from app.tournament_event_stages import mint_stages
from app.tournament_queries import fixtures_by_event
from tests._helpers import event_groups, make_user

#: How many groups the events below carry. Ten is the smallest field that used to
#: tell an id sort from a position sort under the old client-minted ids (``p-10-``
#: sorts between ``p-1-`` and ``p-2-``); under server-minted uuids any two would do,
#: and ten keeps the odds of a random id order coinciding with the director's at one
#: in 3,628,800.
GROUP_COUNT = 10


def _reservation(position: int) -> dict[str, Any]:
    """One reservation as the seed helper takes it — no ``id``, because a group id is
    the database's to mint (ADR 20260801) and the seed reads it back off the event."""
    return {
        "name": f"Reservation {position + 1}",
        "position": position,
        "slot": {},
        "table_ids": [],
    }


def _group_ids(event: TournamentEvent) -> list[uuid.UUID]:
    """The event's group ids **in the director's order** — ``event.groups`` is ordered
    by ``position``, which is the order they were seeded in."""
    return [group.id for group in event.groups]


def _stage_a(event: TournamentEvent) -> uuid.UUID:
    """The id of the event's (only, for round-robin) stage — position 0, the one a
    director's groups hang off (ADR 20260815 decision 3), and what every fixture this
    file seeds directly is named by now (ADR 20260815 decision 5)."""
    return event.stages[0].id


async def _make_event(
    db_session: AsyncSession, reservations: list[dict[str, Any]]
) -> TournamentEvent:
    """A published round-robin event carrying exactly these reservations.

    Written straight to the database: nothing here is about who may create a
    tournament, and the group *order* these seed is the thing under test, which the
    write boundary would take from the payload's own order rather than from the
    positions stated here.
    """
    owner = await make_user(db_session, f"director-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db_session)
    assert league is not None, "the autouse default_league fixture seeds this"

    tournament = Tournament(
        name="Spring Open",
        status=TournamentStatus.published,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db_session.add(tournament)
    await db_session.flush()

    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=64,
        entry_fee=Decimal("20.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
        stages=stages,
    )
    # This file's ordering rule is unrelated to any draw type's real materialisation
    # (#1484 floors round-robin at exactly one group) — it is exercised directly
    # against ``GROUP_COUNT`` seeded groups, one per reservation.
    stages[0].groups = event_groups(
        reservations, event=event, group_count=len(reservations)
    )
    db_session.add(event)
    await db_session.commit()
    # Both ``groups`` (VIEWONLY) and ``stages`` (not eager) are populated on refresh,
    # not by construction (ADR 20260815) — ``_group_ids``/``_stage_a`` need both.
    await db_session.refresh(event, attribute_names=["groups", "stages"])
    return event


async def _seed_fixtures(
    db_session: AsyncSession,
    event: TournamentEvent,
    rows: list[tuple[uuid.UUID, int, int]],
    *,
    stage_id: uuid.UUID | None = None,
) -> None:
    """Write ``(group_id, round, position)`` fixtures — in the order given, which
    every caller below deliberately scrambles: insertion order is what an unsorted
    read returns, so rows seeded in the right order could not tell a broken
    ``ORDER BY`` from a working one.

    Defaults to the event's stage 0 — every caller but the cross-stage ordering test
    below is single-stage."""
    resolved_stage_id = stage_id if stage_id is not None else _stage_a(event)
    for group_id, round_number, position in rows:
        db_session.add(
            TournamentFixture(
                stage_id=resolved_stage_id,
                group_id=group_id,
                round=round_number,
                position=position,
            )
        )
    await db_session.commit()


@pytest_asyncio.fixture
async def ten_group_event(db_session: AsyncSession) -> TournamentEvent:
    """An event with ten groups, positions 0..9, in the director's order."""
    return await _make_event(db_session, [_reservation(n) for n in range(GROUP_COUNT)])


async def test_ten_groups_come_back_in_the_directors_group_order(
    db_session: AsyncSession, ten_group_event: TournamentEvent
) -> None:
    """The one this exists for: ten groups read back 1..10, not in the order their ids
    happen to sort in.

    Under the old ``ORDER BY group_id`` a ten-group event's draw came back with group
    10's fixtures wedged between group 1's and group 2's, on every read, for every
    client; under server-minted uuids the same bug deals the groups in a *random*
    order. Nothing about the response looks wrong either way; it is simply the wrong
    draw on screen.

    The assertion is the **full sequence**, so it fails on an id sort rather than
    merely on an unsorted one — a "the groups are contiguous" check would pass
    against both.
    """
    group_ids = _group_ids(ten_group_event)
    # The premise, asserted rather than assumed: the ids do NOT sort into the director's
    # order, so a loader that fell back to an id sort produces a different sequence.
    assert sorted(group_ids) != group_ids
    await _seed_fixtures(
        db_session,
        ten_group_event,
        # Scrambled: the ids' own order, which is the order the broken rule produced and
        # the one a re-broken implementation would fall back into.
        [(group_id, 1, 1) for group_id in sorted(group_ids)],
    )

    fixtures = (await fixtures_by_event(db_session, [ten_group_event.id]))[
        ten_group_event.id
    ]

    assert [fixture.group_id for fixture in fixtures] == group_ids


async def test_a_groups_round_and_position_still_decide_within_the_group(
    db_session: AsyncSession, ten_group_event: TournamentEvent
) -> None:
    """Group order is the *outermost* key, not the only one: inside a group the order
    is still round then position, and the groups do not interleave."""
    first, second = _group_ids(ten_group_event)[:2]
    await _seed_fixtures(
        db_session,
        ten_group_event,
        [
            (second, 1, 1),
            (first, 2, 1),
            (first, 1, 2),
            (first, 1, 1),
        ],
    )

    fixtures = (await fixtures_by_event(db_session, [ten_group_event.id]))[
        ten_group_event.id
    ]

    assert [(f.group_id, f.round, f.position) for f in fixtures] == [
        (first, 1, 1),
        (first, 1, 2),
        (first, 2, 1),
        (second, 1, 1),
    ]


# There is deliberately no "groups stored before ``position`` existed keep their id
# order" test any more. It seeded groups with no ``position`` key at all, which a
# JSONB array could hold and the ``NOT NULL position`` column of
# ``tournament_event_stage_groups`` cannot (ADR 20260801) — and, pre-deploy, there are
# no such rows for it to describe. The group id remains the loader's secondary sort
# key regardless — a tie-break between two groups the position subquery ranks equally
# — which ``test_each_events_group_order_is_read_from_its_own_groups`` below still
# exercises through real, positioned groups.
#
# There is also deliberately no more "ungrouped fixtures sort last" test.
# ``test_ungrouped_fixtures_sort_last_behind_every_group`` pinned the NULLS LAST
# behavior of the loader's ``_group_position().asc().nulls_last()`` key against a
# fixture with no group at all — a state #1484 makes unrepresentable
# (``tournament_fixtures.group_id`` is ``NOT NULL``, and every stage a draw type's
# template mints holds a group). The ``nulls_last()`` call itself is left in place,
# unexercised defense against a group somehow failing to resolve, rather than removed
# — see ``_group_position``'s own docstring. What replaces it is below: the SAME
# "the knockout sorts after the groups that feed it" claim, now proven through a
# real second stage rather than a NULL.


async def test_a_knockout_stages_group_sorts_after_the_group_stages(
    db_session: AsyncSession,
) -> None:
    """A groups-then-knockout draw's knockout stage sorts strictly after its group
    stage, even though the two stages' groups can share a ``position`` (#1484: a
    group's ``position`` is unique only within its own stage, so an
    ``rr-then-ko`` event's knockout group and the group stage's own group 1 are
    both ``position: 0``).

    The knockout group's id is pinned **lower** than either pool group's
    (``uuid.UUID(int=1)`` against ``int=2``/``int=3``), so a loader that ordered on
    position and then group id — with no stage key ahead of them — would break the
    ``position: 0`` tie in the knockout's favor and sort it FIRST, ahead of even the
    group stage's own group 1. That is the #1348 sighting's shape: the knockout
    escaping its group stage's order. Under a fix that leads with the fixture's own
    stage, the id tie-break never gets a say — the knockout sorts last regardless of
    which id is lower, which is what tells this test apart from one that merely
    got lucky on uuid comparison.
    """
    owner = await make_user(db_session, "director-rrko-order")
    league = await get_default_league(db_session)
    assert league is not None, "the autouse default_league fixture seeds this"
    tournament = Tournament(
        name="Spring Open",
        status=TournamentStatus.published,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db_session.add(tournament)
    await db_session.flush()

    stages = mint_stages(DrawType.rr_then_ko)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.rr_then_ko),
        max_players=64,
        entry_fee=Decimal("20.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
        stages=stages,
    )
    pool_group_1 = TournamentEventStageGroup(id=uuid.UUID(int=2), position=0)
    pool_group_2 = TournamentEventStageGroup(id=uuid.UUID(int=3), position=1)
    stages[0].groups = [pool_group_1, pool_group_2]
    # Deliberately the LOWER id of the three, so an id tie-break (no stage key ahead
    # of it) would sort this group — and therefore the knockout stage — FIRST.
    knockout_group = TournamentEventStageGroup(id=uuid.UUID(int=1), position=0)
    stages[1].groups = [knockout_group]
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event, attribute_names=["stages"])

    await _seed_fixtures(
        db_session,
        event,
        [(pool_group_2.id, 1, 1), (pool_group_1.id, 1, 1)],
        stage_id=stages[0].id,
    )
    await _seed_fixtures(
        db_session, event, [(knockout_group.id, 1, 1)], stage_id=stages[1].id
    )

    fixtures = (await fixtures_by_event(db_session, [event.id]))[event.id]

    assert [f.group_id for f in fixtures] == [
        pool_group_1.id,
        pool_group_2.id,
        knockout_group.id,
    ]


async def test_each_events_group_order_is_read_from_its_own_groups(
    db_session: AsyncSession, ten_group_event: TournamentEvent
) -> None:
    """The loader is batched over many events at once, and each event's draw must come
    back in **its own** group order — not in one order the whole batch shares.

    Two ten-group events whose orders deliberately disagree with each other and with
    the ids: the first is read back in its director's order, the second in its own,
    and no single global sort key satisfies both. That is what tells a per-event
    lookup from a batch-wide one — a loader that ordered by the id, or by any one
    column of its own table, would satisfy at most one of the two assertions.

    (Its predecessor gave the two events the **same** group ids in opposite orders,
    to catch a subquery that leaked across events. That input is no longer
    constructible: a group id is a server-minted uuid and its primary key is the id
    alone, so two events cannot share one — the leak it was written against would now
    find the right group whatever event it looked in.)
    """
    other_event = await _make_event(
        db_session, [_reservation(n) for n in range(GROUP_COUNT)]
    )
    ours, theirs = _group_ids(ten_group_event), _group_ids(other_event)
    # The premise: neither event's order is the id order, so an id sort reds both.
    assert sorted(ours) != ours and sorted(theirs) != theirs
    for event, group_ids in ((ten_group_event, ours), (other_event, theirs)):
        await _seed_fixtures(
            db_session, event, [(group_id, 1, 1) for group_id in sorted(group_ids)]
        )

    fixtures = await fixtures_by_event(db_session, [ten_group_event.id, other_event.id])

    assert [f.group_id for f in fixtures[ten_group_event.id]] == ours
    assert [f.group_id for f in fixtures[other_event.id]] == theirs
