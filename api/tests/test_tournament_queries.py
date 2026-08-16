"""The draw read path's **order**: ``app.tournament_queries.fixtures_by_event``.

A draw has one order, and the loader is where it is decided (in SQL, because a NULL
``pool_id`` is not comparable to anything in Python). What that order sorts pools by is
the subject here: the pool's ``position`` in its event's own pool order — the
server-stamped, 0-based field pools carry (ADR 20260801, "Pools carry an explicit
``position``") — and *not* the pool's id.

The distinction is not academic and is not about the future. Pool ids were
client-minted strings, ``p-1-…``, ``p-2-…``, ``p-10-…``, and lexicographically ``p-10-``
falls between ``p-1-`` and ``p-2-``: an event with ten or more pools rendered its draw
as pool 1, pool 10, pool 2, pool 3, … They are server-minted uuids now (ADR 20260801),
which
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
    TournamentFixture,
    TournamentStatus,
)
from app.tournament_event_stages import mint_stages
from app.tournament_queries import fixtures_by_event
from tests._helpers import event_pools, make_user

#: How many pools the events below carry. Ten is the smallest field that used to tell an
#: id sort from a position sort under the old client-minted ids (``p-10-`` sorts between
#: ``p-1-`` and ``p-2-``); under server-minted uuids any two would do, and ten keeps the
#: odds of a random id order coinciding with the director's at one in 3,628,800.
POOL_COUNT = 10


def _pool(position: int) -> dict[str, Any]:
    """One pool as the seed helper takes it — no ``id``, because a pool id is the
    database's to mint (ADR 20260801) and the seed reads it back off the event."""
    return {
        "name": f"Pool {position + 1}",
        "position": position,
        "slot": {},
        "table_ids": [],
    }


def _pool_ids(event: TournamentEvent) -> list[uuid.UUID]:
    """The event's pool ids **in the director's order** — ``event.groups`` is ordered by
    ``position``, which is the order they were seeded in."""
    return [pool.id for pool in event.groups]


def _stage_a(event: TournamentEvent) -> uuid.UUID:
    """The id of the event's (only, for round-robin) stage — position 0, the one a
    director's pools hang off (ADR 20260815 decision 3), and what every fixture this
    file seeds directly is named by now (ADR 20260815 decision 5)."""
    return event.stages[0].id


async def _make_event(
    db_session: AsyncSession, pools: list[dict[str, Any]]
) -> TournamentEvent:
    """A published round-robin event carrying exactly these pools.

    Written straight to the database: nothing here is about who may create a tournament,
    and the pool *order* these seed is the thing under test, which the write boundary
    would take from the payload's own order rather than from the positions stated here.
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
    stages[0].groups = event_pools(pools, event=event)
    db_session.add(event)
    await db_session.commit()
    # Both ``pools`` (VIEWONLY) and ``stages`` (not eager) are populated on refresh, not
    # by construction (ADR 20260815) — ``_pool_ids``/``_stage_a`` need both.
    await db_session.refresh(event, attribute_names=["groups", "stages"])
    return event


async def _seed_fixtures(
    db_session: AsyncSession,
    event: TournamentEvent,
    rows: list[tuple[uuid.UUID | None, int, int]],
) -> None:
    """Write ``(pool_id, round, position)`` fixtures — in the order given, which every
    caller below deliberately scrambles: insertion order is what an unsorted read
    returns, so rows seeded in the right order could not tell a broken ``ORDER BY`` from
    a working one."""
    stage_id = _stage_a(event)
    for pool_id, round_number, position in rows:
        db_session.add(
            TournamentFixture(
                stage_id=stage_id,
                group_id=pool_id,
                round=round_number,
                position=position,
            )
        )
    await db_session.commit()


@pytest_asyncio.fixture
async def ten_pool_event(db_session: AsyncSession) -> TournamentEvent:
    """An event with ten pools, positions 0..9, in the director's order."""
    return await _make_event(db_session, [_pool(n) for n in range(POOL_COUNT)])


async def test_ten_pools_come_back_in_the_directors_pool_order(
    db_session: AsyncSession, ten_pool_event: TournamentEvent
) -> None:
    """The one this exists for: ten pools read back 1..10, not in the order their ids
    happen to sort in.

    Under the old ``ORDER BY pool_id`` a ten-pool event's draw came back with pool 10's
    fixtures wedged between pool 1's and pool 2's, on every read, for every client;
    under server-minted uuids the same bug deals the pools in a *random* order. Nothing
    about the response looks wrong either way; it is simply the wrong draw on screen.

    The assertion is the **full sequence**, so it fails on an id sort rather than merely
    on an unsorted one — a "the pools are contiguous" check would pass against both.
    """
    pool_ids = _pool_ids(ten_pool_event)
    # The premise, asserted rather than assumed: the ids do NOT sort into the director's
    # order, so a loader that fell back to an id sort produces a different sequence.
    assert sorted(pool_ids) != pool_ids
    await _seed_fixtures(
        db_session,
        ten_pool_event,
        # Scrambled: the ids' own order, which is the order the broken rule produced and
        # the one a re-broken implementation would fall back into.
        [(pool_id, 1, 1) for pool_id in sorted(pool_ids)],
    )

    fixtures = (await fixtures_by_event(db_session, [ten_pool_event.id]))[
        ten_pool_event.id
    ]

    assert [fixture.pool_id for fixture in fixtures] == pool_ids


async def test_a_pools_round_and_position_still_decide_within_the_pool(
    db_session: AsyncSession, ten_pool_event: TournamentEvent
) -> None:
    """Pool order is the *outermost* key, not the only one: inside a pool the order is
    still round then position, and the pools do not interleave."""
    first, second = _pool_ids(ten_pool_event)[:2]
    await _seed_fixtures(
        db_session,
        ten_pool_event,
        [
            (second, 1, 1),
            (first, 2, 1),
            (first, 1, 2),
            (first, 1, 1),
        ],
    )

    fixtures = (await fixtures_by_event(db_session, [ten_pool_event.id]))[
        ten_pool_event.id
    ]

    assert [(f.pool_id, f.round, f.position) for f in fixtures] == [
        (first, 1, 1),
        (first, 1, 2),
        (first, 2, 1),
        (second, 1, 1),
    ]


async def test_un_pooled_fixtures_sort_last_behind_every_pool(
    db_session: AsyncSession, ten_pool_event: TournamentEvent
) -> None:
    """A NULL ``pool_id`` is a real value — "this fixture belongs to no pool" — and it
    belongs LAST, after the pools that feed it: that is a pools-then-knockout draw's KO
    stage following its pool stage, and it is the claim the ``NULLS LAST`` in the loader
    exists for.

    It survives the move onto ``position`` unchanged, and needs saying again *because*
    it moved: the new key is a subquery that returns NULL for an un-pooled fixture (it
    matches no pool), so the un-pooled would sort wherever NULLs land by default —
    which, for a ``DESC`` or a different dialect, is first, in front of the pools.
    """
    await _seed_fixtures(
        db_session,
        ten_pool_event,
        [
            (None, 1, 1),
            (None, 1, 2),
            (_pool_ids(ten_pool_event)[9], 1, 1),
            (_pool_ids(ten_pool_event)[0], 1, 1),
        ],
    )

    fixtures = (await fixtures_by_event(db_session, [ten_pool_event.id]))[
        ten_pool_event.id
    ]

    assert [(f.pool_id, f.position) for f in fixtures] == [
        (_pool_ids(ten_pool_event)[0], 1),
        (_pool_ids(ten_pool_event)[9], 1),
        (None, 1),
        (None, 2),
    ]


# There is deliberately no "pools stored before ``position`` existed keep their id
# order" test any more. It seeded pools with no ``position`` key at all, which a JSONB
# array could hold and the ``NOT NULL position`` column of ``tournament_event_pools``
# cannot (ADR 20260801) — and, pre-deploy, there are no such rows for it to describe.
# The pool id remains the loader's secondary sort key for the case that IS still
# reachable: an un-pooled draw, where the position subquery is NULL for every fixture
# (``test_un_pooled_fixtures_sort_last_behind_every_pool``).


async def test_each_events_pool_order_is_read_from_its_own_pools(
    db_session: AsyncSession, ten_pool_event: TournamentEvent
) -> None:
    """The loader is batched over many events at once, and each event's draw must come
    back in **its own** pool order — not in one order the whole batch shares.

    Two ten-pool events whose orders deliberately disagree with each other and with the
    ids: the first is read back in its director's order, the second in its own, and no
    single global sort key satisfies both. That is what tells a per-event lookup from a
    batch-wide one — a loader that ordered by the id, or by any one column of its own
    table, would satisfy at most one of the two assertions.

    (Its predecessor gave the two events the **same** pool ids in opposite orders, to
    catch a subquery that leaked across events. That input is no longer constructible:
    a pool id is a server-minted uuid and its primary key is the id alone, so two events
    cannot share one — the leak it was written against would now find the right pool
    whatever event it looked in.)
    """
    other_event = await _make_event(db_session, [_pool(n) for n in range(POOL_COUNT)])
    ours, theirs = _pool_ids(ten_pool_event), _pool_ids(other_event)
    # The premise: neither event's order is the id order, so an id sort reds both.
    assert sorted(ours) != ours and sorted(theirs) != theirs
    for event, pool_ids in ((ten_pool_event, ours), (other_event, theirs)):
        await _seed_fixtures(
            db_session, event, [(pool_id, 1, 1) for pool_id in sorted(pool_ids)]
        )

    fixtures = await fixtures_by_event(db_session, [ten_pool_event.id, other_event.id])

    assert [f.pool_id for f in fixtures[ten_pool_event.id]] == ours
    assert [f.pool_id for f in fixtures[other_event.id]] == theirs
