"""Parse and replace an event's owned draw configuration.

The event stores a draw-type FK and a NOT NULL JSON object. Type-specific rules
belong to the existing discriminated union; SQL enforces the reference and object
shape. Values have no independent identity, timestamps, or cleanup lifecycle.
"""

from app.models import TournamentEvent, TournamentEventDrawSettings
from app.schemas.tournament import DrawSettingsWriteArm, draw_settings_from_storage


def draw_settings_of(value: TournamentEventDrawSettings) -> DrawSettingsWriteArm:
    """Decode storage once so callers hold the typed settings arm."""
    return draw_settings_from_storage(value.draw_type, dict(value.settings))


def draw_settings_value(settings: DrawSettingsWriteArm) -> TournamentEventDrawSettings:
    """Encode a parsed arm as one complete configuration value."""
    return TournamentEventDrawSettings.for_draw_type(
        settings.draw_type, settings=settings.stored_settings()
    )


def store_draw_settings(event: TournamentEvent, settings: DrawSettingsWriteArm) -> None:
    """Replace both parts together; changing type discards the previous settings."""
    event.draw_settings = draw_settings_value(settings)
