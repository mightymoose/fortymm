"""Durable storage budgets for retained draw history."""

import uuid

from sqlalchemy import Text, cast, func, literal, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import DrawStorageLimitExceeded
from app.models import (
    Account,
    TournamentDrawRevision,
    TournamentEvent,
)
from app.models.tournament_draw_revision import MAX_DRAW_CONFIGURATION_BYTES

MAX_FIXTURES_PER_CUT = 150_000
MAX_FIXTURES_PER_TOURNAMENT = 250_000
MAX_FIXTURES_PER_ACTOR = 500_000
MAX_REVISIONS_PER_TOURNAMENT = 32
MAX_REVISIONS_PER_ACTOR = 128


async def enforce_draw_storage(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    fixture_count: int,
    actor_id: uuid.UUID | None,
) -> None:
    """Read bounded revision counters while the caller holds the tournament lock."""
    if fixture_count > MAX_FIXTURES_PER_CUT:
        raise DrawStorageLimitExceeded("cut", "fixtures", MAX_FIXTURES_PER_CUT)
    tournament_counts = (
        await db.scalars(
            select(TournamentDrawRevision.retained_fixture_count)
            .join(
                TournamentEvent, TournamentEvent.id == TournamentDrawRevision.event_id
            )
            .where(TournamentEvent.tournament_id == tournament_id)
            .limit(MAX_REVISIONS_PER_TOURNAMENT + 1)
        )
    ).all()
    if len(tournament_counts) >= MAX_REVISIONS_PER_TOURNAMENT:
        raise DrawStorageLimitExceeded(
            "tournament", "draw revisions", MAX_REVISIONS_PER_TOURNAMENT
        )
    if sum(tournament_counts) + fixture_count > MAX_FIXTURES_PER_TOURNAMENT:
        raise DrawStorageLimitExceeded(
            "tournament", "fixtures", MAX_FIXTURES_PER_TOURNAMENT
        )

    if actor_id is None:
        return
    actor_counts = (
        await db.scalars(
            select(TournamentDrawRevision.retained_fixture_count)
            .where(TournamentDrawRevision.created_by_account_id == actor_id)
            .limit(MAX_REVISIONS_PER_ACTOR + 1)
        )
    ).all()
    if len(actor_counts) >= MAX_REVISIONS_PER_ACTOR:
        raise DrawStorageLimitExceeded(
            "account", "draw revisions", MAX_REVISIONS_PER_ACTOR
        )
    if sum(actor_counts) + fixture_count > MAX_FIXTURES_PER_ACTOR:
        raise DrawStorageLimitExceeded("account", "fixtures", MAX_FIXTURES_PER_ACTOR)


async def lock_draw_actor(db: AsyncSession, actor_id: uuid.UUID) -> None:
    """Serialize this actor's cuts before taking any tournament lock."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:actor, 1710))"),
        {"actor": str(actor_id)},
    )
    # The revision's historical-actor FK must not take this lock after Tournament,
    # where a concurrent Account merge already holding Account would invert it.
    await db.execute(
        select(Account.id)
        .where(Account.id == actor_id)
        .with_for_update(read=True, key_share=True)
    )


async def enforce_draw_configuration_size(
    db: AsyncSession, configuration: dict[str, object]
) -> None:
    """Measure the exact JSONB text representation enforced by the database check."""
    byte_count = (
        await db.execute(
            select(func.octet_length(cast(literal(configuration, type_=JSONB), Text)))
        )
    ).scalar_one()
    if byte_count > MAX_DRAW_CONFIGURATION_BYTES:
        raise DrawStorageLimitExceeded(
            "cut", "configuration bytes", MAX_DRAW_CONFIGURATION_BYTES
        )
