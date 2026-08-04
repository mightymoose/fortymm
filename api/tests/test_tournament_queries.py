"""The draw read path's **order**: ``app.tournament_queries.fixtures_by_event``.

A draw has one order, and the loader is where it is decided (in SQL, because a NULL
``pool_id`` is not comparable to anything in Python). What that order sorts pools by is
the subject here: the pool's ``position`` in its event's own pool order — the
server-stamped, 0-based field pools carry (ADR 20260801, "Pools carry an explicit
``position``") — and *not* the pool's id.

The distinction is not academic and is not about the future. Pool ids are client-minted
strings, ``p-1-…``, ``p-2-…``, ``p-10-…``, and lexicographically ``p-10-`` falls between
``p-1-`` and ``p-2-``: an event with ten or more pools rendered its draw as pool 1, pool
10, pool 2, pool 3, … Every test below is written to fail against an id sort, which is
why the ids are chosen so their lexicographic order differs from the director's.

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
from app.tournament_queries import fixtures_by_event
from tests._helpers import make_user

#: Ten pool ids in the **director's** order, minted the way the client mints them. Their
#: lexicographic order is ``p-1-…, p-10-…, p-2-…, p-3-…`` — deliberately not this one,
#: which is the whole point: a test whose ids happened to sort right could not tell an
#: id sort from a position sort.
POOL_IDS = [f"p-{n}-{uuid.uuid4().hex[:6]}" for n in range(1, 11)]


def _pool(pool_id: str, position: int) -> dict[str, Any]:
    """One pool as it is stored — the JSONB shape the write boundary produces."""
    return {
        "id": pool_id,
        "name": f"Pool {position + 1}",
        "position": position,
        "slot": {},
        "table_ids": [],
    }


async def _make_event(
    db_session: AsyncSession, pools: list[dict[str, Any]]
) -> TournamentEvent:
    """A published round-robin event carrying exactly these pools.

    Written straight to the database: nothing here is about who may create a tournament,
    and the pools are seeded in shapes (a stored ``position``, and a legacy one with no
    such key) that only the write boundary can produce or refuse.
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
        pools=pools,
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    return event


async def _seed_fixtures(
    db_session: AsyncSession,
    event: TournamentEvent,
    rows: list[tuple[str | None, int, int]],
) -> None:
    """Write ``(pool_id, round, position)`` fixtures — in the order given, which every
    caller below deliberately scrambles: insertion order is what an unsorted read
    returns, so rows seeded in the right order could not tell a broken ``ORDER BY`` from
    a working one."""
    for pool_id, round_number, position in rows:
        db_session.add(
            TournamentFixture(
                event_id=event.id,
                pool_id=pool_id,
                round=round_number,
                position=position,
            )
        )
    await db_session.commit()


@pytest_asyncio.fixture
async def ten_pool_event(db_session: AsyncSession) -> TournamentEvent:
    """An event with ten pools, positions 0..9, in the director's order."""
    return await _make_event(
        db_session,
        [_pool(pool_id, position) for position, pool_id in enumerate(POOL_IDS)],
    )


async def test_ten_pools_come_back_in_the_directors_pool_order(
    db_session: AsyncSession, ten_pool_event: TournamentEvent
) -> None:
    """The one this exists for: ten pools read back 1..10, not 1, 10, 2, 3…

    Ten is the smallest field that tells the two rules apart, because ``p-10-`` is the
    first client-minted id whose lexicographic place is not its director's place — it
    sorts between ``p-1-`` and ``p-2-``. Under the old ``ORDER BY pool_id`` this event's
    draw came back with pool 10's fixtures wedged between pool 1's and pool 2's, on
    every read, for every client. Nothing about the response looked wrong; it was simply
    the wrong draw on screen.

    The assertion is the **full sequence**, so it fails on an id sort rather than merely
    on an unsorted one — a "the pools are contiguous" check would pass against both.
    """
    await _seed_fixtures(
        db_session,
        ten_pool_event,
        # Scrambled: the ids' own lexicographic order, which is the order the broken
        # rule produced and the one a re-broken implementation would fall back into.
        [(pool_id, 1, 1) for pool_id in sorted(POOL_IDS)],
    )

    fixtures = (await fixtures_by_event(db_session, [ten_pool_event.id]))[
        ten_pool_event.id
    ]

    assert [fixture.pool_id for fixture in fixtures] == POOL_IDS


async def test_a_pools_round_and_position_still_decide_within_the_pool(
    db_session: AsyncSession, ten_pool_event: TournamentEvent
) -> None:
    """Pool order is the *outermost* key, not the only one: inside a pool the order is
    still round then position, and the pools do not interleave."""
    first, second = POOL_IDS[0], POOL_IDS[1]
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
            (POOL_IDS[9], 1, 1),
            (POOL_IDS[0], 1, 1),
        ],
    )

    fixtures = (await fixtures_by_event(db_session, [ten_pool_event.id]))[
        ten_pool_event.id
    ]

    assert [(f.pool_id, f.position) for f in fixtures] == [
        (POOL_IDS[0], 1),
        (POOL_IDS[9], 1),
        (None, 1),
        (None, 2),
    ]


async def test_pools_stored_before_positions_existed_keep_their_id_order(
    db_session: AsyncSession,
) -> None:
    """A pool written before ``position`` existed carries no such key, so the subquery
    reads NULL for it — and the whole event degrades to exactly the id order the loader
    had before this change, rather than to no order at all.

    That is what the pool **id** is still doing as a secondary sort key. A read boundary
    must not turn a history it cannot change into a scrambled draw, and there is no
    migration in this slice: these rows exist today.
    """
    legacy = [
        {"id": pool_id, "name": pool_id, "slot": {}, "table_ids": []}
        for pool_id in POOL_IDS
    ]
    event = await _make_event(db_session, legacy)
    await _seed_fixtures(
        db_session, event, [(pool_id, 1, 1) for pool_id in reversed(POOL_IDS)]
    )

    fixtures = (await fixtures_by_event(db_session, [event.id]))[event.id]

    assert [fixture.pool_id for fixture in fixtures] == sorted(POOL_IDS)


async def test_each_events_pool_order_is_read_from_its_own_pools(
    db_session: AsyncSession, ten_pool_event: TournamentEvent
) -> None:
    """The loader is batched over many events at once, so the pool-order lookup has to
    be correlated to *each fixture's own event* — a subquery that leaked across events
    would resolve one event's pool ref against another's pools and read a position that
    is not its own (or, with a shared id, the wrong one entirely).

    The second event reuses the **same ids in the opposite order**, which is the input
    that tells a correlated lookup from a leaky one: under a leak both events come back
    in one of the two orders, and the two assertions cannot both hold.
    """
    reversed_event = await _make_event(
        db_session,
        [
            _pool(pool_id, position)
            for position, pool_id in enumerate(reversed(POOL_IDS))
        ],
    )
    for event in (ten_pool_event, reversed_event):
        await _seed_fixtures(
            db_session, event, [(pool_id, 1, 1) for pool_id in sorted(POOL_IDS)]
        )

    fixtures = await fixtures_by_event(
        db_session, [ten_pool_event.id, reversed_event.id]
    )

    assert [f.pool_id for f in fixtures[ten_pool_event.id]] == POOL_IDS
    assert [f.pool_id for f in fixtures[reversed_event.id]] == list(reversed(POOL_IDS))
