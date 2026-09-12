"""Capture draw configuration independently of the event's editable reservations."""

import uuid

from pydantic import BaseModel, ConfigDict

from app.models import TournamentEvent
from app.schemas.tournament import (
    DrawSettingsWriteArm,
    EventStageRead,
    GroupRead,
    Reservation,
)
from app.tournament_draw_settings import draw_settings_of
from app.tournament_event_stages import stage_template
from app.tournament_reservations import (
    group_count_for,
    group_read,
    ordered_reservations,
    reservation_read,
)


class DrawConfigurationSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID
    draw_settings: DrawSettingsWriteArm
    stages: list[EventStageRead]
    groups: list[GroupRead]
    reservations: list[Reservation]


def snapshot_draw_configuration(event: TournamentEvent) -> dict[str, object]:
    """Encode the loaded configuration once, before mutable settings can change."""
    return preview_draw_configuration(event).model_dump(mode="json")


def preview_draw_configuration(
    event: TournamentEvent, *, materialise_field_size: int | None = None
) -> DrawConfigurationSnapshot:
    """Plan the snapshot without retiring history or inserting stage/group rows."""
    groups = [group_read(group) for group in event.groups]
    if materialise_field_size is not None:
        reservations = ordered_reservations(event)
        groups = [
            GroupRead(
                id=uuid.uuid4(),
                position=position,
                stage_id=stage.id,
                reservation_id=(
                    reservations[position % len(reservations)].id
                    if reservations
                    else None
                ),
            )
            for stage, (_, count_source) in zip(
                sorted(event.stages, key=lambda stage: stage.position),
                stage_template(draw_settings_of(event.draw_settings).draw_type),
                strict=True,
            )
            for position in range(
                group_count_for(count_source, field_size=materialise_field_size)
            )
        ]
    return DrawConfigurationSnapshot(
        event_id=event.id,
        draw_settings=draw_settings_of(event.draw_settings),
        stages=[EventStageRead.model_validate(stage) for stage in event.stages],
        groups=groups,
        reservations=[reservation_read(row) for row in event.reservations],
    )


def bind_draw_configuration(
    preview: DrawConfigurationSnapshot, event: TournamentEvent
) -> dict[str, object]:
    """Replace only UUIDs with persisted identities; encoded byte size is unchanged."""
    positions = {stage.id: stage.position for stage in preview.stages}
    stage_ids = {stage.position: stage.id for stage in event.stages}
    actual_positions = {stage.id: stage.position for stage in event.stages}
    group_ids = {
        (actual_positions[group.stage_id], group.position): group.id
        for group in event.groups
    }
    return preview.model_copy(
        update={
            "stages": [
                stage.model_copy(update={"id": stage_ids[stage.position]})
                for stage in preview.stages
            ],
            "groups": [
                group.model_copy(
                    update={
                        "id": group_ids[(positions[group.stage_id], group.position)],
                        "stage_id": stage_ids[positions[group.stage_id]],
                    }
                )
                for group in preview.groups
            ],
        }
    ).model_dump(mode="json")
