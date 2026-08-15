"""Tests for stage minting and re-minting (ADR 20260815 decisions 1, 3, 4).

Covers ``app.tournament_event_stages`` (the template, the mint, the re-mint) and its
two call sites in ``app.tournament_events`` — ``create_event`` and ``update_event``.
Nothing here touches a route, a response schema, or any read path: nothing reads a
stage yet in this chore (see ``docs/adr/20260815-...``, decision 3, and the chore's own
scope guard).
"""

import uuid
from decimal import Decimal
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    EventFormat,
    League,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventStage,
    TournamentFixture,
    User,
)
from app.models.draw_type import DRAW_TYPE_IDS
from app.schemas.tournament import Address, TournamentEventCreate, TournamentEventUpdate
from app.tournament_errors import DrawTypeFrozenError
from app.tournament_event_stages import mint_stages, stage_template
from app.tournament_events import create_event, update_event
from tests._helpers import make_user, venue_tables


def _address() -> Address:
    return Address(
        venue="Berkeley TT Club",
        street="2727 Milvia St",
        city="Berkeley",
        region="CA",
        postal="94703",
        country="USA",
        latitude=37.8703,
        longitude=-122.2731,
    )


async def _make_tournament(
    db: AsyncSession, *, owner: User, league: League
) -> Tournament:
    tournament = Tournament(
        name="Stagey Cup",
        address=_address().model_dump(),
        tables=venue_tables(("Table 1", "A")),
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


def _event_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Stagey Singles",
        "format": "singles",
        "draw_type": "single-elim",
        "max_players": 32,
        "entry_fee": 0,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": True, "length_games": 5},
        "predicates": [],
        "pools": [],
    }
    body.update(overrides)
    return body


def _event_payload(**overrides: Any) -> TournamentEventCreate:
    return TournamentEventCreate.model_validate(_event_body(**overrides))


def _pooled(**overrides: Any) -> dict[str, Any]:
    """A create-event body carrying one empty-reservation pool — what a pooled draw
    type (``round-robin``, ``rr-then-ko``) is seeded with here. The reservation list is
    empty on purpose: this file is about stage rows, not table placements."""
    return _event_body(
        pools=[
            {
                "name": "Pool A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": [],
            }
        ],
        **overrides,
    )


async def _stages(db: AsyncSession, event_id: uuid.UUID) -> list[TournamentEventStage]:
    """This event's stage rows, read fresh off the database and ordered by position —
    never through ``TournamentEvent.stages`` (see that relationship's docstring)."""
    rows = (
        await db.execute(
            select(TournamentEventStage)
            .where(TournamentEventStage.event_id == event_id)
            .order_by(TournamentEventStage.position)
        )
    ).scalars()
    return list(rows)


def _positions(
    stages: list[TournamentEventStage],
) -> list[tuple[int, uuid.UUID]]:
    """``(position, draw_type_id)`` per stage — what every assertion in this file
    compares.

    ``draw_type_id``, never the ``draw_type`` property: that property reads through
    the eager ``draw_type_option`` relationship, which is not automatically re-pointed
    by a re-mint's plain FK-column write on an object still tracked in the session's
    identity map from an earlier query in the same test (the same caveat
    ``TournamentEventDrawSettings.draw_type``'s setter documents for its own column).
    ``draw_type_id`` is a plain column — no relationship hydration involved — and it
    is exactly what a re-mint writes, so comparing it against ``DRAW_TYPE_IDS`` is a
    direct, sound proof of persisted state without fighting the ORM's identity map."""
    return [(stage.position, stage.draw_type_id) for stage in stages]


async def _mark_drawn(db: AsyncSession, event: TournamentEvent) -> None:
    """Give ``event`` a fixture, which is all ``event_has_draw`` looks at — the same
    minimal cut simulation ``test_tournament_events._add_cut_event`` uses, without a
    real pool to point the fixture at (single-elim/swiss fixtures carry no pool
    either)."""
    db.add(TournamentFixture(event_id=event.id, pool_id=None, round=1, position=1))
    await db.commit()


# ----- the template ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("draw_type", "expected"),
    [
        (DrawType.round_robin, (DrawType.round_robin,)),
        (DrawType.single_elim, (DrawType.single_elim,)),
        (DrawType.swiss, (DrawType.swiss,)),
        (DrawType.rr_then_ko, (DrawType.round_robin, DrawType.single_elim)),
    ],
)
def test_stage_template_per_draw_type(
    draw_type: DrawType, expected: tuple[DrawType, ...]
) -> None:
    """Round robin, single elim and swiss are each their own one-stage template;
    rr-then-ko is the only composite, and its two stages are round-robin then
    single-elim, in that order (ADR 20260815 decision 3)."""
    assert stage_template(draw_type) == expected


def test_mint_stages_positions_from_zero() -> None:
    """``mint_stages`` builds one row per template entry, 0-based and in template
    order — the shape ``app.tournament_events.create_event`` passes straight into
    ``TournamentEvent(..., stages=...)``.

    Compared on ``draw_type_id`` (against ``DRAW_TYPE_IDS``), not the ``draw_type``
    property: these rows are unattached to any session, so ``draw_type_option`` — the
    joined relationship the property reads through — was never loaded, and reading it
    on a fresh in-memory object would be an ``AttributeError``."""
    minted = mint_stages(DrawType.rr_then_ko)
    assert [(stage.position, stage.draw_type_id) for stage in minted] == [
        (0, DRAW_TYPE_IDS[DrawType.round_robin]),
        (1, DRAW_TYPE_IDS[DrawType.single_elim]),
    ]


def test_rr_then_ko_is_unmintable_as_a_stages_own_draw_type() -> None:
    """A stage's ``draw_type`` can never be ``rr_then_ko`` — decision 4's "there is no
    stage-runnable flag; the code refuses rr_then_ko as a stage's type at the
    boundary". Pinned directly at the model's setter, which is the seam every mint and
    re-mint path writes through, rather than only through ``stage_template`` (which
    never produces this input on the ordinary path by construction)."""
    with pytest.raises(ValueError, match="rr_then_ko"):
        TournamentEventStage(position=0, draw_type=DrawType.rr_then_ko)


# ----- create: every event is born with its minted stages --------------------------


async def test_create_event_mints_one_stage_for_a_single_stage_draw_type(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "stages-create-single")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(draw_type="single-elim"),
    )

    stages = await _stages(db_session, event.id)
    assert _positions(stages) == [(0, DRAW_TYPE_IDS[DrawType.single_elim])]


async def test_create_event_mints_two_stages_for_rr_then_ko(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The one composite template, persisted as two rows in the SAME transaction the
    event itself is created in — queried back fresh, not read off the returned
    object, so this proves the rows were actually written."""
    owner = await make_user(db_session, "stages-create-composite")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)

    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=TournamentEventCreate.model_validate(
            _pooled(draw_type="rr-then-ko", qualifiers_per_pool=2)
        ),
    )

    stages = await _stages(db_session, event.id)
    assert _positions(stages) == [
        (0, DRAW_TYPE_IDS[DrawType.round_robin]),
        (1, DRAW_TYPE_IDS[DrawType.single_elim]),
    ]


# ----- update: re-minting the template in place -------------------------------------


async def test_update_event_remint_grows_one_stage_to_two_preserving_stage_zero(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """single-elim (1 stage) -> rr-then-ko (2 stages): position 0 keeps its row
    identity while its draw type moves from single-elim to round-robin, and position 1
    is a brand-new row (ADR 20260815 decision 3, "stage 1 keeps its identity and its
    draw type is updated")."""
    owner = await make_user(db_session, "stages-update-grow")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(draw_type="single-elim"),
    )
    before = await _stages(db_session, event.id)
    assert _positions(before) == [(0, DRAW_TYPE_IDS[DrawType.single_elim])]
    stage_zero_id = before[0].id

    await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "draw_type": "rr-then-ko",
                "qualifiers_per_pool": 2,
                "pools": [
                    {
                        "name": "Pool A",
                        "slot": {
                            "date": "2026-06-13",
                            "start": "09:00",
                            "end": "12:30",
                        },
                        "table_ids": [],
                    }
                ],
            }
        ),
    )

    after = await _stages(db_session, event.id)
    assert _positions(after) == [
        (0, DRAW_TYPE_IDS[DrawType.round_robin]),
        (1, DRAW_TYPE_IDS[DrawType.single_elim]),
    ]
    # Stage 0's ROW IDENTITY survived the change — only its draw type moved.
    assert after[0].id == stage_zero_id
    # Stage 1 is new: no row at position 1 existed before.
    assert after[1].id not in {stage.id for stage in before}


async def test_update_event_remint_shrinks_two_stages_to_one_preserving_stage_zero(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """rr-then-ko (2 stages) -> single-elim (1 stage): position 0 keeps its row
    identity while its draw type moves from round-robin to single-elim, and position 1
    is dropped."""
    owner = await make_user(db_session, "stages-update-shrink")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=TournamentEventCreate.model_validate(
            _pooled(draw_type="rr-then-ko", qualifiers_per_pool=2)
        ),
    )
    before = await _stages(db_session, event.id)
    assert _positions(before) == [
        (0, DRAW_TYPE_IDS[DrawType.round_robin]),
        (1, DRAW_TYPE_IDS[DrawType.single_elim]),
    ]
    stage_zero_id = before[0].id
    stage_one_id = before[1].id

    await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate({"draw_type": "single-elim"}),
    )

    after = await _stages(db_session, event.id)
    assert _positions(after) == [(0, DRAW_TYPE_IDS[DrawType.single_elim])]
    assert after[0].id == stage_zero_id
    # Position 1's row is gone, not merely un-listed.
    assert (
        await db_session.execute(
            select(TournamentEventStage).where(TournamentEventStage.id == stage_one_id)
        )
    ).scalar_one_or_none() is None


async def test_update_event_remint_mints_fresh_when_no_stage_rows_exist(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A total function, not a partial one: an event seeded straight through the ORM
    (bypassing ``create_event``, so it holds zero stage rows — the same construction
    ``test_tournament_events`` uses for its own fixtures) mints the whole template
    fresh on its first draw-type change, rather than indexing into an empty list."""
    owner = await make_user(db_session, "stages-update-fresh")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="ORM-Seeded Event",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.single_elim),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=[],
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    assert await _stages(db_session, event.id) == []

    await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {"draw_type": "swiss", "rounds": 4}
        ),
    )

    stages = await _stages(db_session, event.id)
    assert _positions(stages) == [(0, DRAW_TYPE_IDS[DrawType.swiss])]


# ----- freeze: stages never move once a draw exists ---------------------------------


async def test_stages_freeze_once_a_draw_exists_even_on_a_no_op_patch(
    db_session: AsyncSession,
    default_league: League,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The case the ordinary freeze (``_enforce_draw_settings_frozen``) does NOT catch
    by itself: a PATCH that resends the event's current draw settings unchanged is
    waved through even under a standing draw (``test_tournament_events
    .test_update_event_re_sending_the_same_draw_type_is_not_frozen`` pins that at the
    HTTP-adjacent layer). ``remint_stages_in_place`` must never run in that case.

    Pinned on the CALL, not the resulting row state: resending the identical draw type
    means the template ``remint_stages_in_place`` would re-apply is the one already
    stored, so its own writes are a no-op in this exact case (stage 0's ``draw_type``
    is written back to its own value, nothing is added or removed) — the row state
    would look identical whether or not the gate exists, which would make a
    before/after row comparison pass for the wrong reason. Mocking the seam
    ``update_event`` calls through is what actually discriminates: removing the
    ``if not await event_has_draw(...)`` gate at ``app.tournament_events.update_event``
    makes this red, which a row-state assertion here would not."""
    owner = await make_user(db_session, "stages-freeze-noop")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(draw_type="single-elim"),
    )
    await _mark_drawn(db_session, event)

    remint = AsyncMock()
    monkeypatch.setattr("app.tournament_events.remint_stages_in_place", remint)

    updated, _ = await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {"name": "Renamed Under Draw", "draw_type": "single-elim"}
        ),
    )
    assert updated.name == "Renamed Under Draw"
    remint.assert_not_called()


async def test_stages_freeze_blocks_remint_when_the_draw_type_change_itself_is_refused(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The ordinary case: a REAL draw-type change under a standing draw is refused by
    ``_enforce_draw_settings_frozen`` before anything is written, so the stage rows are
    untouched (this is the belt; the no-op case above is the suspenders)."""
    owner = await make_user(db_session, "stages-freeze-refused")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=_event_payload(draw_type="single-elim"),
    )
    await _mark_drawn(db_session, event)
    before = await _stages(db_session, event.id)
    before_snapshot = [(s.id, s.position, s.draw_type_id) for s in before]

    with pytest.raises(DrawTypeFrozenError):
        await update_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event.id,
            actor=owner,
            updates=TournamentEventUpdate.model_validate({"draw_type": "round-robin"}),
        )

    after = await _stages(db_session, event.id)
    after_snapshot = [(s.id, s.position, s.draw_type_id) for s in after]
    assert after_snapshot == before_snapshot
