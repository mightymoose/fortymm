"""Persistence tests for ``tournament_fixtures``.

The load-bearing claim is the ``UNIQUE (event_id, pool_id, round, position)``
constraint — the identity a re-cut reconciles on (ADR-0786). The tests below are
written to fail if that constraint is missing *or* if it is scoped wrongly: a
duplicate ``(event, pool, round, position)`` must be refused by the database, while
the same ``(round, position)`` in a **different pool** (or a different event) must be
accepted, because pooled draws number their fixtures per-pool.

The constraint is **NULLS NOT DISTINCT**, and that is load-bearing rather than
decorative: an un-pooled draw (single-elim — the whole of #785) has ``pool_id IS NULL``
on *every* row, and under Postgres's default NULLS-DISTINCT semantics NULL compares
unequal to itself, so such a draw would have **no uniqueness guard at all**.
``test_duplicate_round_and_position_in_an_un_pooled_draw_is_rejected`` is the test that
tells the two apart — it fails against a default (NULLS DISTINCT) constraint.

They also pin the two encodings the schema deliberately relies on: a ``NULL`` side
means TBD (never a bye — a bye is the *absence* of a row), and a ``NULL`` ``pool_id``
means the draw is un-pooled.

These exercise the schema the **models** declare (the suite builds via
``Base.metadata.create_all``); that the **migration** declares the same schema is
covered by running ``alembic upgrade head`` against a fresh database.
"""

import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from tests._helpers import make_user

FIXTURE_IDENTITY_CONSTRAINT = "uq_tournament_fixtures_event_id_pool_id_round_position"


async def _make_event(db_session: AsyncSession) -> TournamentEvent:
    """A round-robin event under a published tournament owned by a throwaway director.

    Written straight to the database rather than through the create routes: nothing
    here is about who may create a tournament, and the draw endpoints don't exist yet.
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
        draw_type=DrawType.round_robin,
        max_players=64,
        entry_fee=Decimal("20.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
        pools=[
            {"id": "pool-a", "name": "Pool A", "slot": {}, "table_ids": []},
            {"id": "pool-b", "name": "Pool B", "slot": {}, "table_ids": []},
        ],
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    return event


async def _make_entry(db_session: AsyncSession, event: TournamentEvent) -> User:
    player = await make_user(db_session, f"player-{uuid.uuid4().hex[:8]}")
    db_session.add(TournamentEntry(event_id=event.id, user_id=player.id))
    await db_session.commit()
    return player


@pytest_asyncio.fixture
async def event(db_session: AsyncSession) -> TournamentEvent:
    return await _make_event(db_session)


async def test_a_fixture_persists_with_both_sides_tbd(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """A cut draw may contain fixtures whose sides are not known yet — that is what a
    ``NULL`` side is *for*, and it is the only thing it means."""
    db_session.add(
        TournamentFixture(event_id=event.id, pool_id=None, round=2, position=1)
    )
    await db_session.commit()

    stored = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.event_id == event.id)
        )
    ).scalar_one()
    assert stored.entry_a_id is None
    assert stored.entry_b_id is None
    assert stored.winner_entry_id is None
    assert stored.match_id is None
    assert stored.pool_id is None
    assert stored.created_at.tzinfo is not None
    assert stored.updated_at.tzinfo is not None


async def test_a_fixture_holds_its_two_entries(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    entry_a = (
        await db_session.execute(
            select(TournamentEntry).where(
                TournamentEntry.user_id == (await _make_entry(db_session, event)).id
            )
        )
    ).scalar_one()
    entry_b = (
        await db_session.execute(
            select(TournamentEntry).where(
                TournamentEntry.user_id == (await _make_entry(db_session, event)).id
            )
        )
    ).scalar_one()

    db_session.add(
        TournamentFixture(
            event_id=event.id,
            pool_id="pool-a",
            round=1,
            position=1,
            entry_a_id=entry_a.id,
            entry_b_id=entry_b.id,
        )
    )
    await db_session.commit()

    stored = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.event_id == event.id)
        )
    ).scalar_one()
    assert {stored.entry_a_id, stored.entry_b_id} == {entry_a.id, entry_b.id}


async def test_duplicate_round_and_position_in_the_same_pool_is_rejected(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """The identity of a fixture within its draw. Two rows claiming
    ``(event, pool-a, round 1, position 1)`` is a corrupt draw, and the *database* —
    not a read-then-write check — is what refuses it."""
    db_session.add(
        TournamentFixture(event_id=event.id, pool_id="pool-a", round=1, position=1)
    )
    await db_session.commit()

    db_session.add(
        TournamentFixture(event_id=event.id, pool_id="pool-a", round=1, position=1)
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert FIXTURE_IDENTITY_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()


async def test_duplicate_round_and_position_in_an_un_pooled_draw_is_rejected(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """The un-pooled case — a single-elim draw, where ``pool_id`` is ``NULL`` on every
    fixture. This is the test the ``NULLS NOT DISTINCT`` clause exists for: under
    Postgres's *default* semantics ``NULL != NULL``, so a plain unique constraint would
    let this duplicate through and leave the entire single-elim draw type unguarded.
    Fails against a default (NULLS DISTINCT) constraint."""
    db_session.add(
        TournamentFixture(event_id=event.id, pool_id=None, round=1, position=1)
    )
    await db_session.commit()

    db_session.add(
        TournamentFixture(event_id=event.id, pool_id=None, round=1, position=1)
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert FIXTURE_IDENTITY_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()


async def test_an_un_pooled_round_and_position_in_a_different_event_is_accepted(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """NULLS NOT DISTINCT tightens the guard *within* an event; it must not leak across
    events. Two single-elim events each have a ``(NULL pool, round 1, position 1)``, and
    both rows are legitimate."""
    other_event = await _make_event(db_session)

    db_session.add(
        TournamentFixture(event_id=event.id, pool_id=None, round=1, position=1)
    )
    db_session.add(
        TournamentFixture(event_id=other_event.id, pool_id=None, round=1, position=1)
    )
    await db_session.commit()

    stored = (await db_session.execute(select(TournamentFixture))).scalars().all()
    assert sorted(str(f.event_id) for f in stored) == sorted(
        [str(event.id), str(other_event.id)]
    )
    assert all(f.pool_id is None for f in stored)


async def test_the_same_round_and_position_in_a_different_pool_is_accepted(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """Pooled draws number their fixtures **per pool**: every pool of a round-robin has
    a round 1, position 1. A unique constraint that left ``pool_id`` out would reject
    this legitimate row, so this test is what pins the constraint's *scope*."""
    db_session.add(
        TournamentFixture(event_id=event.id, pool_id="pool-a", round=1, position=1)
    )
    db_session.add(
        TournamentFixture(event_id=event.id, pool_id="pool-b", round=1, position=1)
    )
    await db_session.commit()

    stored = (
        (
            await db_session.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event.id)
            )
        )
        .scalars()
        .all()
    )
    assert sorted(f.pool_id or "" for f in stored) == ["pool-a", "pool-b"]


async def test_the_same_round_and_position_in_a_different_event_is_accepted(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """Fixture identity is scoped to its event: two events' draws both have a
    ``(pool-a, round 1, position 1)``. A constraint that omitted ``event_id`` would
    reject the second event's draw."""
    other_event = await _make_event(db_session)

    db_session.add(
        TournamentFixture(event_id=event.id, pool_id="pool-a", round=1, position=1)
    )
    db_session.add(
        TournamentFixture(
            event_id=other_event.id, pool_id="pool-a", round=1, position=1
        )
    )
    await db_session.commit()

    assert (
        len((await db_session.execute(select(TournamentFixture))).scalars().all()) == 2
    )


async def test_deleting_the_event_takes_its_fixtures_with_it(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """The fixtures are part of the event, not free-standing rows — and the FK cascade
    must survive the *entry* FKs, whose rows the same delete is also cascading away."""
    player = await _make_entry(db_session, event)
    entry = (
        await db_session.execute(
            select(TournamentEntry).where(TournamentEntry.user_id == player.id)
        )
    ).scalar_one()
    db_session.add(
        TournamentFixture(
            event_id=event.id,
            pool_id="pool-a",
            round=1,
            position=1,
            entry_a_id=entry.id,
        )
    )
    await db_session.commit()

    stored_event = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event.id)
        )
    ).scalar_one()
    await db_session.delete(stored_event)
    await db_session.commit()

    assert (await db_session.execute(select(TournamentFixture))).scalars().all() == []


async def test_the_events_fixtures_relationship_is_ordered_pool_round_position(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """``TournamentEvent.fixtures`` comes back in the **one** canonical draw order —
    pool → round → position — which is the order the read path's ``fixtures_by_event``
    loader already returns.

    A draw has one order. The relationship used to sort by ``(round, position)`` alone,
    which for a *pooled* draw interleaved the pools: pool A's round 1 next to pool B's
    round 1. So the same fixtures came back in two different sequences depending on
    which of the two ways a caller happened to read them, and the one that rendered a
    scrambled bracket was whichever one a future feature reached for first. Nothing
    consumed the relationship at the time, which is exactly why it was worth fixing
    before something did.

    The rows are inserted in deliberately the wrong order (pool B before pool A, round 2
    before round 1, the un-pooled fixture first), because insertion order is what an
    unordered read returns — a fixture seeded in the right order could not tell a broken
    ``order_by`` from a working one.

    The un-pooled fixture (``pool_id`` NULL — an rr-then-ko event's KO stage) sorts
    LAST, after the pools that feed it. NULL is a real value here ("this fixture belongs
    to no pool"), not a missing one, so it has a defined place in the order rather than
    wherever the dialect's default happens to put it.
    """
    for pool_id, round_number, position in [
        (None, 1, 1),
        ("pool-b", 1, 1),
        ("pool-a", 2, 1),
        ("pool-a", 1, 2),
        ("pool-a", 1, 1),
    ]:
        db_session.add(
            TournamentFixture(
                event_id=event.id,
                pool_id=pool_id,
                round=round_number,
                position=position,
            )
        )
    await db_session.commit()

    loaded = (
        await db_session.execute(
            select(TournamentEvent)
            .where(TournamentEvent.id == event.id)
            .options(selectinload(TournamentEvent.fixtures))
        )
    ).scalar_one()

    assert [(f.pool_id, f.round, f.position) for f in loaded.fixtures] == [
        ("pool-a", 1, 1),
        ("pool-a", 1, 2),
        ("pool-a", 2, 1),
        ("pool-b", 1, 1),
        (None, 1, 1),
    ]
