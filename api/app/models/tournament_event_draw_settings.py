"""An event-owned draw configuration value, with no identity or lifecycle."""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.models.draw_type import DRAW_TYPE_IDS, DRAW_TYPES_BY_ID
from app.models.tournament import DrawType


@dataclass(frozen=True)
class TournamentEventDrawSettings:
    """Storage value; application callers parse it through draw_settings_of.

    Assign a replacement value to the event to persist a change. The event copies
    the JSON on assignment and read, so even a value reused by two events cannot
    share mutable storage. This is not an ORM entity.
    """

    draw_type_id: uuid.UUID
    settings: Mapping[str, Any]

    @classmethod
    def for_draw_type(
        cls, draw_type: DrawType, *, settings: Mapping[str, Any] | None = None
    ) -> "TournamentEventDrawSettings":
        """Build a storage value. Use the parsed union for application writes."""
        return cls(
            DRAW_TYPE_IDS[draw_type], dict(settings) if settings is not None else {}
        )

    @property
    def draw_type(self) -> DrawType:
        return DRAW_TYPES_BY_ID[self.draw_type_id]
