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
from app.tournament_reservations import group_read, reservation_read


class DrawConfigurationSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID
    draw_settings: DrawSettingsWriteArm
    stages: list[EventStageRead]
    groups: list[GroupRead]
    reservations: list[Reservation]


def snapshot_draw_configuration(event: TournamentEvent) -> dict[str, object]:
    """Encode the loaded configuration once, before mutable settings can change."""
    return DrawConfigurationSnapshot(
        event_id=event.id,
        draw_settings=draw_settings_of(event.draw_settings),
        stages=[EventStageRead.model_validate(stage) for stage in event.stages],
        groups=[group_read(group) for group in event.groups],
        reservations=[reservation_read(row) for row in event.reservations],
    ).model_dump(mode="json")
