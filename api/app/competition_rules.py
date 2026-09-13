"""Frozen competition rules, captured once and parsed at the storage seam."""

import uuid
from datetime import timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TournamentEvent
from app.models.match_settings import VerificationPolicy
from app.models.tournament import DrawType
from app.models.tournament_draw_revision import TournamentDrawRevision
from app.schemas.tournament import DrawSettingsWriteArm, draw_settings_from_storage
from app.schemas.tournament import MatchSettings as EventMatchSettings
from app.tournament_draw_settings import draw_settings_of


class FrozenMatchRules(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    rule_version: Literal[1]
    team_size: Literal[1, 2]
    best_of: Literal[1, 3, 5, 7]
    affects_rating: bool
    verification_policy: VerificationPolicy
    retirement_window: timedelta | None


def snapshot_match_rules(event: TournamentEvent) -> dict[str, object]:
    settings = EventMatchSettings.model_validate(event.match_settings)
    return FrozenMatchRules(
        rule_version=1,
        team_size=2 if event.format.value == "doubles" else 1,
        best_of=settings.length_games,
        affects_rating=settings.rated,
        verification_policy=VerificationPolicy.none,
        retirement_window=timedelta(days=7),
    ).model_dump(mode="json")


async def match_rules_for_revision(
    db: AsyncSession, revision_id: uuid.UUID
) -> FrozenMatchRules:
    revision = (
        await db.scalars(
            select(TournamentDrawRevision).where(
                TournamentDrawRevision.id == revision_id,
            )
        )
    ).one()
    return FrozenMatchRules.model_validate(revision.match_rules)


class FrozenFormatRules(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1]
    draw_type: DrawType
    settings: dict[str, object]


def snapshot_format_rules(event: TournamentEvent) -> dict[str, object]:
    settings = draw_settings_of(event.draw_settings)
    return FrozenFormatRules(
        version=1, draw_type=settings.draw_type, settings=settings.stored_settings()
    ).model_dump(mode="json")


def effective_draw_settings(event: TournamentEvent) -> DrawSettingsWriteArm:
    revision = event.current_rule_revision
    if revision is None:
        return draw_settings_of(event.draw_settings)
    rules = FrozenFormatRules.model_validate(revision.format_rules)
    return draw_settings_from_storage(rules.draw_type, rules.settings)


def effective_match_settings(event: TournamentEvent) -> EventMatchSettings:
    """Match duration/rating for current competition, or editable planning values."""
    revision = event.current_rule_revision
    if revision is None:
        return EventMatchSettings.model_validate(event.match_settings)
    rules = FrozenMatchRules.model_validate(revision.match_rules)
    return EventMatchSettings.model_validate(
        {
            "rated": rules.affects_rating,
            "length_games": rules.best_of,
        }
    )


def format_rule_version(event: TournamentEvent) -> int:
    revision = event.current_rule_revision
    return (
        1
        if revision is None
        else FrozenFormatRules.model_validate(revision.format_rules).version
    )
