"""Tests for stage minting and re-minting (ADR 20260815 decisions 1, 3, 4), and for the
tournament-detail and tournament-list reads that serve them.

Covers ``app.tournament_event_stages`` (the template, the mint, the re-mint) and its
two call sites in ``app.tournament_events`` — ``create_event`` and ``update_event`` —
plus every read path that serves ``TournamentEvent.stages``
(``lazy="selectin"``): the tournament-detail read (``GET /v1/tournaments/{id}``) and
the tournament LIST alike now carry an event's real stages; only the single-event
create/update responses are out of this chore's scope (see
``app.tournament_serialization``).
"""

import uuid
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any
from unittest.mock import ANY, AsyncMock

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import (
    EntryId,
    FixtureGames,
    FixtureId,
    FixtureStage,
    FixtureState,
    GroupId,
    RrThenKoStrategy,
    Side,
    SideFill,
)
from app.models import (
    DrawType,
    EventFormat,
    League,
    Tournament,
    TournamentEvent,
    TournamentEventStage,
    TournamentEventStageGroup,
    TournamentFixture,
    User,
)
from app.schemas.tournament import Address, TournamentEventCreate, TournamentEventUpdate
from app.tournament_errors import DrawTypeFrozenError
from app.tournament_event_stages import (
    GroupCountSource,
    mint_stages,
    remint_stages_in_place,
    stage_template,
)
from app.tournament_events import create_event, update_event
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import (
    event_draw_settings,
    grant_permissions,
    make_user,
    stage_id_at,
    start_session,
    venue_tables,
)


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
        "reservations": [],
    }
    body.update(overrides)
    return body


def _event_payload(**overrides: Any) -> TournamentEventCreate:
    return TournamentEventCreate.model_validate(_event_body(**overrides))


def _grouped(**overrides: Any) -> dict[str, Any]:
    """A create-event body carrying one empty-table reservation — what a grouped
    draw type (``round-robin``, ``rr-then-ko``) is seeded with here. The reservation
    list's ``table_ids`` is empty on purpose: this file is about stage rows, not table
    placements."""
    return _event_body(
        reservations=[
            {
                "name": "Reservation A",
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
) -> list[tuple[int, DrawType]]:
    """``(position, draw_type)`` per stage — what every assertion in this file
    compares.

    Straight off the ``draw_type`` property, safely now: ADR 20260815 retired the
    ``draw_type_option`` join that property used to read through (a relationship that
    was not automatically re-pointed by a re-mint's plain FK-column write on an object
    still tracked in the session's identity map from an earlier query in the same
    test). The property is a plain dict lookup on ``draw_type_id``
    (``DRAW_TYPES_BY_ID``) now — no relationship hydration involved, and no stale-join
    hazard to route around — so comparing it directly is exactly as sound as comparing
    ``draw_type_id`` against ``DRAW_TYPE_IDS`` was, and reads as the domain type
    instead of its storage id."""
    return [(stage.position, stage.draw_type) for stage in stages]


async def _mark_drawn(db: AsyncSession, event: TournamentEvent) -> None:
    """Give ``event`` a fixture, which is all ``event_has_draw`` looks at — the same
    minimal cut simulation ``test_tournament_events._add_cut_event`` uses. The
    fixture names its stage's real group: every event write already materialises
    one (#1484's floor), so ``group_id`` is never ``NULL`` and minting a second
    row at the same ``(stage_id, position)`` would collide with it.

    Named by its stage 0, resolved through ``stage_id_at`` rather than
    ``event.stages[0]`` — not because ``TournamentEvent.stages`` would fail (it is
    eager, ``lazy="selectin"``), but because ``event`` here may be a Python-built
    object this helper's caller never re-queried, so its collection may not be
    populated at all. The single-stage draw types this file drives never need
    position 1."""
    stage_id = await stage_id_at(db, event.id, 0)
    group_id = (
        await db.execute(
            select(TournamentEventStageGroup.id).where(
                TournamentEventStageGroup.stage_id == stage_id,
                TournamentEventStageGroup.position == 0,
            )
        )
    ).scalar_one()
    db.add(TournamentFixture(stage_id=stage_id, group_id=group_id, round=1, position=1))
    await db.commit()


# ----- the template ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("draw_type", "expected"),
    [
        (DrawType.round_robin, ((DrawType.round_robin, GroupCountSource.one),)),
        (DrawType.single_elim, ((DrawType.single_elim, GroupCountSource.one),)),
        (DrawType.swiss, ((DrawType.swiss, GroupCountSource.one),)),
        (
            DrawType.rr_then_ko,
            (
                (DrawType.round_robin, GroupCountSource.structural),
                (DrawType.single_elim, GroupCountSource.one),
            ),
        ),
    ],
)
def test_stage_template_per_draw_type(
    draw_type: DrawType, expected: tuple[tuple[DrawType, GroupCountSource], ...]
) -> None:
    """Round robin, single elim and swiss are each their own one-stage template, and
    hold exactly one group whatever the field (#1484); rr-then-ko is the only
    composite, and its two stages are round-robin then single-elim, in that order
    (ADR 20260815 decision 3) — the first deriving its count from the event's
    structural settings, the second always exactly one (#1484 decision 1)."""
    assert stage_template(draw_type) == expected


def test_mint_stages_positions_from_zero() -> None:
    """``mint_stages`` builds one row per template entry, 0-based and in template
    order — the shape ``app.tournament_events.create_event`` passes straight into
    ``TournamentEvent(..., stages=...)``.

    Compared on the ``draw_type`` property directly — safe even though these rows are
    unattached to any session, since ADR 20260815 retired the joined relationship that
    property used to read through. It is a plain dict lookup on ``draw_type_id`` now
    (``DRAW_TYPES_BY_ID``), so it needs no loaded relationship and no session at all."""
    minted = mint_stages(DrawType.rr_then_ko)
    assert [(stage.position, stage.draw_type) for stage in minted] == [
        (0, DrawType.round_robin),
        (1, DrawType.single_elim),
    ]


def test_stage_template_writer_and_rr_then_ko_strategy_reader_agree() -> None:
    """The lockstep pin for ADR 20260815 decisions 3 and 6: what
    :func:`~app.tournament_event_stages.stage_template` mints for ``rr-then-ko`` (the
    WRITER — since #1483 each strategy STATES the stage it dealt a fixture into, on
    :attr:`~app.draws.PlannedFixture.stage`, and ``app.tournament_draws.cut_draw``
    writes that position through unchanged; :class:`~app.draws.RrThenKoStrategy` deals
    its group half at position 0 and its bracket at position 1) and what
    :class:`~app.draws.RrThenKoStrategy` reads back through
    :attr:`~app.draws.FixtureState.stage` (the READER — its ``_stage_split`` matches on
    ``draw_type``, never on a position literal) have to be the SAME two facts, or a
    real cut's fixtures would land on stages the strategy cannot place.

    Restated in up to four places before this test existed — the template itself,
    ``cut_draw``'s positional write, this composite's own (now-removed)
    ``_RR_THEN_KO_GROUP_STAGE``/``_RR_THEN_KO_KNOCKOUT_STAGE`` position literals, and
    the ``app.draws`` test suite's own copy of that same pair — with nothing checking
    that
    they agreed. This drives a REAL split through ``advance()`` using
    :class:`~app.draws.FixtureStage`\\ s built straight off ``mint_stages``'s own rows
    (never a position literal of its own), so a template reorder (say, knockout before
    group) reds this test for the stated reason, not merely a tuple-equality check.
    """
    stages = mint_stages(DrawType.rr_then_ko)
    fixture_stage_at = {
        stage.position: FixtureStage(position=stage.position, draw_type=stage.draw_type)
        for stage in stages
    }
    # The composite's own deal (app.draws.RrThenKoStrategy.plan_initial): its group
    # half names position 0 and its bracket the template's LAST position — restated
    # here as data pulled off the real mint, not trusted silently to still be true.
    # (Before #1483 this was cut_draw's inference from a fixture's group presence
    # rather than the strategy's own statement; the two positions are the same pair.)
    group_stage = fixture_stage_at[0]
    knockout_stage = fixture_stage_at[len(stages) - 1]

    entry_1, entry_2 = EntryId(uuid.uuid4()), EntryId(uuid.uuid4())
    group_fixture = FixtureState(
        fixture_id=FixtureId(uuid.uuid4()),
        group_id=GroupId(uuid.uuid4()),
        stage=group_stage,
        round=1,
        position=1,
        entry_a_id=entry_1,
        entry_b_id=entry_2,
        winner_entry_id=entry_1,
        games=FixtureGames(entry_a_games=2, entry_b_games=0),
    )
    knockout_fixture_id = FixtureId(uuid.uuid4())
    knockout_fixture = FixtureState(
        fixture_id=knockout_fixture_id,
        group_id=None,
        stage=knockout_stage,
        round=1,
        position=1,
        entry_a_id=None,
        entry_b_id=None,
    )

    plan = RrThenKoStrategy(qualifiers_per_group=2).advance(
        [group_fixture, knockout_fixture], ()
    )

    # The one-group waiver (ADR "one group is an explicit waiver, not a failure"): both
    # of the group's entrants qualify, seed 1 (the winner) to side a and seed 2 to side
    # b of the bracket's only fixture. Seeing this fill at all is only possible if the
    # GROUP fixture (stage 0) was read as the group half its result feeds standings
    # from, and the KNOCKOUT fixture (the template's last position) as the half that
    # receives the seating — i.e. only if the writer's template and the reader's split
    # agree on which position means what.
    assert set(plan.side_fills) == {
        SideFill(fixture_id=knockout_fixture_id, side=Side.a, entry_id=entry_1),
        SideFill(fixture_id=knockout_fixture_id, side=Side.b, entry_id=entry_2),
    }


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
    assert _positions(stages) == [(0, DrawType.single_elim)]


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
            _grouped(draw_type="rr-then-ko", qualifiers_per_group=2)
        ),
    )

    stages = await _stages(db_session, event.id)
    assert _positions(stages) == [
        (0, DrawType.round_robin),
        (1, DrawType.single_elim),
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
    assert _positions(before) == [(0, DrawType.single_elim)]
    stage_zero_id = before[0].id

    await update_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "draw_type": "rr-then-ko",
                "qualifiers_per_group": 2,
                "reservations": [
                    {
                        "name": "Reservation A",
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
        (0, DrawType.round_robin),
        (1, DrawType.single_elim),
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
            _grouped(draw_type="rr-then-ko", qualifiers_per_group=2)
        ),
    )
    before = await _stages(db_session, event.id)
    assert _positions(before) == [
        (0, DrawType.round_robin),
        (1, DrawType.single_elim),
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
    assert _positions(after) == [(0, DrawType.single_elim)]
    assert after[0].id == stage_zero_id
    # Position 1's row is gone, not merely un-listed.
    assert (
        await db_session.execute(
            select(TournamentEventStage).where(TournamentEventStage.id == stage_one_id)
        )
    ).scalar_one_or_none() is None


async def test_remint_retypes_every_retained_position_not_just_stage_zero(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The bug the two-loop rewrite fixed: the old three-branch form wrote position
    0's ``draw_type`` unconditionally (``existing[0].draw_type = template[0]``) but
    touched later positions only from inside the grow/shrink branches — so a re-mint
    onto a template of the SAME length left every position past 0 holding its stale
    ``draw_type``, silently.

    No draw-type change through ``update_event`` can exercise this today:
    ``rr-then-ko`` is the only template longer than one stage, so the only way to
    hold the length at 2 across a re-mint is to re-mint rr-then-ko onto itself — which
    is exactly the identical-type resend the freeze gate in ``app.tournament_events
    .update_event`` now refuses to even call ``remint_stages_in_place`` for (see
    ``test_stages_freeze_once_a_draw_exists_even_on_a_no_op_patch``). So this calls
    ``remint_stages_in_place`` directly — the layer that actually owns the loop being
    pinned — with position 1 corrupted straight through the ORM first (the same
    direct-to-database seam ``test_update_event_remint_mints_fresh_when_no_stage_rows_
    exist`` uses), so the re-mint has real, provable work to do at a position other
    than 0.
    """
    owner = await make_user(db_session, "stages-remint-retype-all")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event, _ = await create_event(
        db_session,
        tournament_id=tournament.id,
        actor=owner,
        payload=TournamentEventCreate.model_validate(
            _grouped(draw_type="rr-then-ko", qualifiers_per_group=2)
        ),
    )
    before = await _stages(db_session, event.id)
    assert _positions(before) == [
        (0, DrawType.round_robin),
        (1, DrawType.single_elim),
    ]
    # Corrupt position 1 directly, bypassing the mint entirely — a stale value no
    # ordinary mint or re-mint would ever write, so an unchanged read-back after the
    # re-mint below could only mean the loop skipped it.
    before[1].draw_type = DrawType.swiss
    await db_session.commit()

    await remint_stages_in_place(db_session, event, DrawType.rr_then_ko)
    await db_session.commit()

    after = await _stages(db_session, event.id)
    assert _positions(after) == [
        (0, DrawType.round_robin),
        (1, DrawType.single_elim),
    ]
    # Both rows kept their identity — a re-mint onto an unchanged-length template
    # writes in place, it never drops and re-adds.
    assert [stage.id for stage in after] == [stage.id for stage in before]


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
        draw_settings=event_draw_settings(DrawType.single_elim),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        groups=[],
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
    assert _positions(stages) == [(0, DrawType.swiss)]


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
    ``if draw_settings.draw_type is not old_draw_type`` gate at
    ``app.tournament_events.update_event`` makes this red, which a row-state
    assertion here would not."""
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


# ----- read: the tournament-detail payload serves each event's stages --------------


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The shared ``api_client`` with a real session whose user holds
    ``tournament.view`` + ``tournament.create`` — the same genuine RBAC rows
    ``test_tournaments`` grants, not a dependency override."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))
    yield api_client, user


def _tournament_payload() -> dict[str, Any]:
    return {
        "name": "Stagey Cup",
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


async def _tournament_with_event(
    client: AsyncClient, **event_overrides: Any
) -> tuple[str, str]:
    """Create a tournament and one event through the real HTTP routes; return both
    ids as strings, matching how the detail read's JSON bodies carry them."""
    tournament = await client.post("/v1/tournaments", json=_tournament_payload())
    assert tournament.status_code == 201, tournament.text
    tournament_id = tournament.json()["id"]
    event = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=_event_body(**event_overrides)
    )
    assert event.status_code == 201, event.text
    return tournament_id, event.json()["id"]


async def _event_of(
    client: AsyncClient, tournament_id: str, event_id: str
) -> dict[str, Any]:
    """The one event's read model, off the tournament-DETAIL payload — ``stages``
    is not its own endpoint (root ``CLAUDE.md``, BFF one-endpoint-per-page); it rides
    on this same read."""
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    (event,) = [e for e in response.json()["events"] if e["id"] == event_id]
    return event


async def test_the_tournament_detail_serves_a_single_elim_events_one_stage(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """A single-stage draw type's event carries exactly one stage on the
    tournament-detail payload: position 0, its own draw type — not ``rr_then_ko``,
    which no stage may ever carry (ADR 20260815 decision 4)."""
    client, _ = authed_client
    tournament_id, event_id = await _tournament_with_event(
        client, draw_type="single-elim"
    )

    event = await _event_of(client, tournament_id, event_id)

    assert [(s["position"], s["draw_type"]) for s in event["stages"]] == [
        (0, "single-elim")
    ]
    assert uuid.UUID(event["stages"][0]["id"])


async def test_the_tournament_detail_serves_an_rr_then_ko_events_two_stages_in_order(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The one composite template reads back as two stages, in ``position`` order:
    the group stage (``round-robin``) at 0, the knockout stage (``single-elim``) at 1
    (ADR 20260815 decisions 3/7) — never the reverse, and never collapsed to one row
    or to ``rr-then-ko`` itself.

    Order is asserted as a list, not a set — see
    ``test_the_detail_payload_carries_the_seeded_draw_types_in_display_order`` in
    ``tests/test_tournaments.py`` for why a sequence, not membership, is the claim
    worth pinning here."""
    client, _ = authed_client
    tournament_id, event_id = await _tournament_with_event(
        client, **_grouped(draw_type="rr-then-ko", qualifiers_per_group=2)
    )

    event = await _event_of(client, tournament_id, event_id)

    assert [(s["position"], s["draw_type"]) for s in event["stages"]] == [
        (0, "round-robin"),
        (1, "single-elim"),
    ]
    # Two distinct stage rows, not one row read twice.
    assert len({s["id"] for s in event["stages"]}) == 2


async def test_the_tournaments_list_carries_per_event_stages_too(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The tournament LIST is no longer a special case: ``TournamentEvent.stages`` is
    ``lazy="selectin"`` now (matching ``groups``), so every event the LIST returns
    carries its real stages, the same shape the tournament-DETAIL read serves for the
    very same event — unlike ``draw_type_catalogue``/``latest_schedule_solve``, which
    stay genuinely list-BFF-scoped sentinels (``tests/test_tournaments.py``'s
    ``test_the_tournaments_list_does_not_carry_the_draw_type_catalogue``); ``stages``
    was never one, it was only unbatched (ADR 20260815)."""
    client, _ = authed_client
    tournament_id, event_id = await _tournament_with_event(
        client, draw_type="single-elim"
    )

    rows = (await client.get("/v1/tournaments")).json()
    listed_tournament = next(row for row in rows if row["id"] == tournament_id)
    (listed_event,) = [e for e in listed_tournament["events"] if e["id"] == event_id]

    expected = [{"id": ANY, "position": 0, "draw_type": "single-elim"}]
    assert listed_event["stages"] == expected
    # And the detail read of the very same event agrees, so the two surfaces cannot
    # drift on how many stages an event has.
    detail_event = await _event_of(client, tournament_id, event_id)
    assert detail_event["stages"] == expected
