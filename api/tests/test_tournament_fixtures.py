"""Persistence tests for ``tournament_fixtures``.

The load-bearing claim is the ``UNIQUE (stage_id, pool_id, round, position)``
constraint — the identity a re-cut reconciles on (ADR-0786, keyed on ``stage_id``
rather than ``event_id`` since ADR 20260815 decision 5). The tests below are
written to fail if that constraint is missing *or* if it is scoped wrongly: a
duplicate ``(stage, pool, round, position)`` must be refused by the database, while
the same ``(round, position)`` in a **different pool** (or a different event/stage)
must be accepted, because pooled draws number their fixtures per-pool.

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
    TournamentEventDrawSettings,
    TournamentEventStage,
    TournamentEventStageGroup,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.tournament_event_stages import mint_stages
from app.tournament_queries import stage_ids_for_events
from tests._helpers import event_pools, make_user

FIXTURE_IDENTITY_CONSTRAINT = "uq_tournament_fixtures_stage_id_pool_id_round_position"
#: The composite foreign key that says a fixture's pool is its own stage's pool
#: (ADR 20260801, re-parented onto the stage by ADR 20260815). Asserted by name, so a
#: test that reds proves the constraint refused this row — not that some other write
#: in the transaction happened to fail.
FIXTURE_POOL_CONSTRAINT = "fk_tournament_fixtures_stage_id_pool_id"


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
    # Two pools, whose ids the seed mints up front (``event_pools``) because a fixture
    # below has to name one before the rows are flushed — and because a pool id is a
    # server-minted uuid now (ADR 20260801), not a string a literal can spell. A pool's
    # real parent is its stage now (ADR 20260815), so they hang off ``stages[0]``, not
    # the event directly; ``_pool_a`` / ``_pool_b`` read them back off the event's
    # (VIEWONLY) ``pools`` association.
    stages[0].groups = event_pools(
        [
            {"name": "Pool A", "slot": {}, "table_ids": []},
            {"name": "Pool B", "slot": {}, "table_ids": []},
        ],
        event=event,
    )
    db_session.add(event)
    await db_session.commit()
    # Both ``pools`` (VIEWONLY) and ``stages`` (not eager) are populated on refresh, not
    # by construction (ADR 20260815) — every fixture this file seeds needs both ids.
    await db_session.refresh(event, attribute_names=["groups", "stages"])
    return event


def _pool_a(event: TournamentEvent) -> uuid.UUID:
    """The id of the event's first pool — ``event.groups`` is ordered by ``position``,
    which is the order ``_make_event`` seeded them in."""
    return event.groups[0].id


def _pool_b(event: TournamentEvent) -> uuid.UUID:
    """The id of the event's second pool."""
    return event.groups[1].id


def _stage_a(event: TournamentEvent) -> uuid.UUID:
    """The id of the event's (only, for round-robin) stage — position 0, the one a
    director's pools hang off (ADR 20260815 decision 3), and what every fixture this
    file seeds directly is named by now (ADR 20260815 decision 5)."""
    return event.stages[0].id


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
        TournamentFixture(stage_id=_stage_a(event), pool_id=None, round=2, position=1)
    )
    await db_session.commit()

    stored = (
        await db_session.execute(
            select(TournamentFixture).where(
                TournamentFixture.stage_id.in_(stage_ids_for_events([event.id]))
            )
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
            stage_id=_stage_a(event),
            pool_id=_pool_a(event),
            round=1,
            position=1,
            entry_a_id=entry_a.id,
            entry_b_id=entry_b.id,
        )
    )
    await db_session.commit()

    stored = (
        await db_session.execute(
            select(TournamentFixture).where(
                TournamentFixture.stage_id.in_(stage_ids_for_events([event.id]))
            )
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
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=_pool_a(event), round=1, position=1
        )
    )
    await db_session.commit()

    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=_pool_a(event), round=1, position=1
        )
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
        TournamentFixture(stage_id=_stage_a(event), pool_id=None, round=1, position=1)
    )
    await db_session.commit()

    db_session.add(
        TournamentFixture(stage_id=_stage_a(event), pool_id=None, round=1, position=1)
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
        TournamentFixture(stage_id=_stage_a(event), pool_id=None, round=1, position=1)
    )
    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(other_event), pool_id=None, round=1, position=1
        )
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
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=_pool_a(event), round=1, position=1
        )
    )
    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=_pool_b(event), round=1, position=1
        )
    )
    await db_session.commit()

    stored = (
        (
            await db_session.execute(
                select(TournamentFixture).where(
                    TournamentFixture.stage_id.in_(stage_ids_for_events([event.id]))
                )
            )
        )
        .scalars()
        .all()
    )
    assert {f.pool_id for f in stored} == {_pool_a(event), _pool_b(event)}


async def test_the_same_round_and_position_in_a_different_event_is_accepted(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """Fixture identity is scoped to its event: two events' draws both have a
    ``(their first pool, round 1, position 1)``. A constraint that omitted ``event_id``
    would reject the second event's draw."""
    other_event = await _make_event(db_session)

    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=_pool_a(event), round=1, position=1
        )
    )
    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(other_event),
            pool_id=_pool_a(other_event),
            round=1,
            position=1,
        )
    )
    await db_session.commit()

    assert (
        len((await db_session.execute(select(TournamentFixture))).scalars().all()) == 2
    )


async def test_a_fixture_in_another_events_pool_is_refused_by_the_database(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """The claim the **composite** foreign key exists to make (ADR 20260801): a
    fixture's pool is one of *its own event's* pools.

    The pool named here **exists** — it is a real row, belonging to the *other* event —
    which is what makes this test able to fail. A plain
    ``pool_id → tournament_event_pools.id`` foreign key would look that id up, find it,
    and accept the row, seating one event's fixture inside another event's pool: exactly
    the illegal state the ADR is about, and exactly the one a non-composite FK cannot
    see. What is refused is the *pair*.

    The refusal lands at COMMIT rather than at the INSERT because the constraint is
    ``DEFERRABLE INITIALLY DEFERRED`` (see the model for why the event-delete path needs
    that), which is a difference in *when*, not in *whether*.
    """
    other_event = await _make_event(db_session)
    elsewhere = uuid.uuid4()
    db_session.add(
        TournamentEventStageGroup(
            id=elsewhere,
            stage_id=_stage_a(other_event),
            position=2,
        )
    )
    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=_pool_a(event), round=1, position=1
        )
    )
    await db_session.commit()
    # Read before the refusal: the rollback below expires every instance in the session,
    # and re-reading an attribute off one afterwards is a lazy refresh in sync context.
    event_id = event.id
    pool_a = _pool_a(event)

    db_session.add(
        TournamentFixture(
            # The other event's pool, under THIS event's id.
            stage_id=_stage_a(event),
            pool_id=elsewhere,
            round=1,
            position=2,
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert FIXTURE_POOL_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()

    # And the legitimate row is still there: the refusal took the offending write, not
    # the draw around it.
    stored = (await db_session.execute(select(TournamentFixture))).scalars().all()
    assert [(f.event_id, f.pool_id) for f in stored] == [(event_id, pool_a)]


async def test_a_fixture_naming_a_pool_that_does_not_exist_is_refused(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """The plainer half of the same key: a ``pool_id`` naming no pool at all.

    It was storable for as long as pools were JSONB value-objects with nothing to point
    at — the dangling ref ADR-0786 could only protect procedurally, with
    ``_enforce_pool_set_frozen``. It is a foreign-key violation now."""
    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=uuid.uuid4(), round=1, position=1
        )
    )
    with pytest.raises(IntegrityError) as excinfo:
        await db_session.commit()
    assert FIXTURE_POOL_CONSTRAINT in str(excinfo.value)
    await db_session.rollback()


async def test_deleting_the_event_takes_its_pools_with_it(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """An event's pools go with the event — and they do so while its **fixtures are
    still there**, which is the case the composite FK's deferral is for.

    Deleting the event removes the pools through the ORM (the collection is eagerly
    loaded) and the fixtures through Postgres' ``ON DELETE CASCADE``, in that order, in
    two separate statements. An immediately-checked constraint fires between them, on
    fixtures that are about to be deleted one statement later, and the whole delete dies
    on a foreign-key violation. This test reds against ``RESTRICT``.
    """
    db_session.add(
        TournamentFixture(
            stage_id=_stage_a(event), pool_id=_pool_a(event), round=1, position=1
        )
    )
    await db_session.commit()
    event_id = event.id

    await db_session.delete(event)
    await db_session.commit()

    pools = (
        (
            await db_session.execute(
                select(TournamentEventStageGroup).where(
                    TournamentEventStageGroup.stage_id.in_(
                        stage_ids_for_events([event_id])
                    )
                )
            )
        )
        .scalars()
        .all()
    )
    assert pools == []


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
            stage_id=_stage_a(event),
            pool_id=_pool_a(event),
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


async def test_the_stages_fixtures_relationship_is_ordered_pool_round_position(
    db_session: AsyncSession, event: TournamentEvent
) -> None:
    """``TournamentEventStage.fixtures`` comes back in the **one** canonical draw
    order — pool → round → position — which is the order the read path's
    ``fixtures_by_event`` loader already returns.

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

    The un-pooled fixture (``pool_id`` NULL — single-elim today, a pools-then-knockout
    draw type's KO stage once #787 adds one) sorts
    LAST, after the pools that feed it. NULL is a real value here ("this fixture belongs
    to no pool"), not a missing one, so it has a defined place in the order rather than
    wherever the dialect's default happens to put it.
    """
    pool_a, pool_b = _pool_a(event), _pool_b(event)
    for pool_id, round_number, position in [
        (None, 1, 1),
        (pool_b, 1, 1),
        (pool_a, 2, 1),
        (pool_a, 1, 2),
        (pool_a, 1, 1),
    ]:
        db_session.add(
            TournamentFixture(
                stage_id=_stage_a(event),
                pool_id=pool_id,
                round=round_number,
                position=position,
            )
        )
    await db_session.commit()

    loaded = (
        await db_session.execute(
            select(TournamentEventStage)
            .where(TournamentEventStage.id == _stage_a(event))
            .options(selectinload(TournamentEventStage.fixtures))
        )
    ).scalar_one()

    # The relationship orders by the pool **id**, which under server-minted uuids is
    # arbitrary — so the expectation is written against whichever of the two sorts
    # first. What is asserted is unchanged and is the whole claim: the pools do not
    # INTERLEAVE (all of one pool's fixtures, then all of the other's), each pool's own
    # fixtures run round → position, and the un-pooled fixture sorts LAST.
    first, second = sorted([pool_a, pool_b])
    assert [(f.pool_id, f.round, f.position) for f in loaded.fixtures] == [
        (first, 1, 1),
        *([(first, 1, 2), (first, 2, 1)] if first == pool_a else []),
        (second, 1, 1),
        *([(second, 1, 2), (second, 2, 1)] if second == pool_a else []),
        (None, 1, 1),
    ]
