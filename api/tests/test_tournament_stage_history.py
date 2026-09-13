"""Draw configuration survives supported uncut, edit, and recut operations."""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, TournamentEventStage, TournamentFixture
from app.schemas.tournament import TournamentEventUpdate
from app.tournament_draw_service import cut_event_draw, uncut_event_draw
from app.tournament_events import update_event
from tests._helpers import make_user
from tests.test_tournament_draw_service import (
    _enter_field,
    _make_event,
    _make_tournament,
)


async def test_uncut_then_change_draw_type_preserves_original_stage_configuration(
    db_session: AsyncSession, default_league: League
) -> None:
    owner = await make_user(db_session, "history-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[])
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="history-player")
    await db_session.refresh(owner)
    original = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    original_ids = [fixture.id for fixture in original]
    await db_session.refresh(owner)
    await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.refresh(event)
    await db_session.refresh(owner)
    changed, _ = await update_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {"draw_type": "single-elim", "lock_version": event.lock_version}
        ),
    )
    assert len(changed.stages) == 1
    assert changed.stages[0].draw_type.value == "single-elim"
    await db_session.refresh(owner)
    replacement = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    assert len(replacement) == 3
    assert not set(original_ids).intersection(fixture.id for fixture in replacement)
    # The archive's fixture-to-stage relation must still describe the original draw.
    stages = (
        (
            await db_session.execute(
                select(TournamentEventStage)
                .join(
                    TournamentFixture,
                    TournamentFixture.stage_id == TournamentEventStage.id,
                )
                .where(TournamentFixture.id.in_(original_ids))
                .execution_options(include_draw_history=True)
            )
        )
        .scalars()
        .all()
    )
    assert stages
    assert all(stage.draw_type.value == "round-robin" for stage in stages)


async def test_retired_revision_keeps_cut_time_reservation_configuration(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.models.tournament_draw_revision import TournamentDrawRevision
    from app.tournament_reservations import reservation_read
    from tests.test_tournament_draw_service import RESERVATION_A

    owner = await make_user(db_session, "snapshot-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[RESERVATION_A])
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="snapshot-player")
    await db_session.refresh(owner)
    original = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    original_id = original[0].id
    await db_session.refresh(owner)
    await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.refresh(event)
    await db_session.refresh(owner)
    reservation = reservation_read(event.reservations[0]).model_dump(mode="json")
    reservation.pop("position")
    reservation["name"] = "New reservation name"
    await update_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {
                "reservations": [reservation],
                "lock_version": event.lock_version,
            }
        ),
    )
    configuration = (
        await db_session.execute(
            select(TournamentDrawRevision.configuration)
            .join(
                TournamentFixture,
                TournamentFixture.draw_revision_id == TournamentDrawRevision.id,
            )
            .where(TournamentFixture.id == original_id)
            .execution_options(include_draw_history=True)
        )
    ).scalar_one()
    assert configuration["reservations"][0]["name"] == "Reservation A"


async def test_recut_smaller_field_keeps_superseded_group_references(
    db_session: AsyncSession, default_league: League
) -> None:
    from app.models import (
        DrawType,
        TournamentEventDrawSettings,
        TournamentEventStageGroup,
        TournamentStatus,
    )
    from app.tournament_entries import withdraw_from_event

    owner = await make_user(db_session, "resize-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament.status = TournamentStatus.published
    event = await _make_event(
        db_session, tournament, draw_type=DrawType.rr_then_ko, groups=[]
    )
    tournament_id, event_id = tournament.id, event.id
    event.draw_settings = TournamentEventDrawSettings.for_draw_type(
        DrawType.rr_then_ko, settings={"qualifiers_per_group": 2}
    )
    entries = await _enter_field(db_session, event, 10, prefix="resize-player")
    entry_ids = [entry.id for entry in entries]
    await db_session.refresh(owner)
    original = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    original_ids = [fixture.id for fixture in original]
    await db_session.refresh(owner)
    await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    for entry_id in entry_ids[5:]:
        await db_session.refresh(owner)
        await withdraw_from_event(
            db_session,
            tournament_id=tournament_id,
            event_id=event_id,
            entry_id=entry_id,
            actor=owner,
        )
    await db_session.refresh(owner)
    replacement = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    assert replacement
    await db_session.refresh(event)
    assert len(event.stages) == 2
    assert len(event.groups) == 2  # One round-robin group and one knockout group.
    original_groups = (
        (
            await db_session.execute(
                select(TournamentEventStageGroup.id)
                .join(
                    TournamentFixture,
                    TournamentFixture.group_id == TournamentEventStageGroup.id,
                )
                .where(TournamentFixture.id.in_(original_ids))
                .execution_options(include_draw_history=True)
            )
        )
        .scalars()
        .all()
    )
    assert (
        len(set(original_groups)) == 3
    )  # Two original pools and the original bracket.
    assert set(original_groups).isdisjoint(group.id for group in event.groups)


@pytest.mark.parametrize(
    "mutation",
    [
        "parent_event",
        "parent_tournament",
        "DELETE FROM tournament_event_group_reservations WHERE group_id=:id",
        "UPDATE tournament_event_group_reservations SET updated_at=clock_timestamp() "
        "WHERE group_id=:id",
        "INSERT INTO tournament_event_group_reservations "
        "SELECT * FROM tournament_event_group_reservations WHERE group_id=:id",
    ],
)
async def test_archived_mapping_rejects_direct_deletion_but_reservation_can_be_removed(
    db_session: AsyncSession, default_league: League, mutation: str
) -> None:
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from tests.test_tournament_draw_service import RESERVATION_A

    owner = await make_user(db_session, "mapping-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, groups=[RESERVATION_A])
    tournament_id, event_id = tournament.id, event.id
    await _enter_field(db_session, event, 4, prefix="mapping-player")
    await db_session.refresh(owner)
    original = await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    group_id = original[0].group_id
    revision_id = await db_session.scalar(
        text("SELECT draw_revision_id FROM tournament_fixtures WHERE id=:id"),
        {"id": original[0].id},
    )
    snapshot = await db_session.scalar(
        text("SELECT configuration FROM tournament_draw_revisions WHERE id=:id"),
        {"id": revision_id},
    )
    await db_session.refresh(owner)
    await uncut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    if mutation.startswith("parent_"):
        with pytest.raises(IntegrityError, match="entry history must be retained"):
            async with db_session.begin_nested():
                if mutation == "parent_event":
                    await db_session.execute(
                        text("DELETE FROM tournament_events WHERE id=:id"),
                        {"id": event_id},
                    )
                else:
                    await db_session.execute(
                        text("DELETE FROM tournaments WHERE id=:id"),
                        {"id": tournament_id},
                    )
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        assert (
            await db_session.scalar(
                text(
                    "SELECT count(*) FROM tournament_event_group_reservations "
                    "WHERE group_id=:id"
                ),
                {"id": group_id},
            )
            == 1
        )
        return
    with pytest.raises(IntegrityError, match="archived group mapping is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(mutation),
                {"id": group_id},
            )
    await db_session.refresh(event)
    await db_session.refresh(owner)
    await update_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
        updates=TournamentEventUpdate.model_validate(
            {"reservations": [], "lock_version": event.lock_version}
        ),
    )
    await db_session.refresh(owner)
    await cut_event_draw(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    assert (
        await db_session.scalar(
            text("SELECT configuration FROM tournament_draw_revisions WHERE id=:id"),
            {"id": revision_id},
        )
        == snapshot
    )
    assert snapshot["groups"][0]["reservation_id"] is not None
    assert snapshot["reservations"][0]["name"] == "Reservation A"
