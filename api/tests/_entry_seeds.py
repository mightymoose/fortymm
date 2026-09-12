"""Valid membership and match-side seeds for tests of existing tournament flows."""

import uuid
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    EventFormat,
    Match,
    MatchSide,
    MatchSidePlayer,
    Player,
    Tournament,
    TournamentEntry,
    TournamentEntryMember,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
)


def entry_with_members(
    db: AsyncSession, event: TournamentEvent, player_id: uuid.UUID, **kwargs: Any
) -> TournamentEntry:
    entry = TournamentEntry(event_id=event.id, user_id=player_id, **kwargs)
    if event.format is EventFormat.doubles:
        partner = Player(id=uuid.uuid4(), username="partner-" + uuid.uuid4().hex)
        db.add(partner)
        entry.members.append(TournamentEntryMember(player_id=partner.id))
    return entry


async def seed_fixture_match_sides(
    db: AsyncSession, fixture: TournamentFixture, match: Match
) -> None:
    """A synthetic running match still needs the players seated by its fixture."""
    if await db.scalar(
        select(MatchSide.id).where(MatchSide.match_id == match.id).limit(1)
    ):
        return
    for number, entry_id in enumerate(
        (fixture.entry_a_id, fixture.entry_b_id), start=1
    ):
        if entry_id is None:
            continue
        side = MatchSide(match_id=match.id, side_number=number)
        db.add(side)
        await db.flush()
        players = await db.scalars(
            select(func.entry_canonical_player(TournamentEntryMember.player_id)).where(
                TournamentEntryMember.entry_id == entry_id,
                TournamentEntryMember.left_at.is_(None),
            )
        )
        db.add_all(
            [
                MatchSidePlayer(
                    match_id=match.id,
                    match_side_id=side.id,
                    user_id=player_id,
                )
                for player_id in players
            ]
        )
    await db.flush()


async def withdraw_entry_with_history(db: AsyncSession, entry_id: uuid.UUID) -> None:
    """Seed a complete director withdrawal, leaving the caller to commit it."""
    from app.tournament_participation import WithdrawalReason, close_registration

    actor_id = (
        await db.execute(
            select(Tournament.owner_account_id)
            .join(TournamentEvent, TournamentEvent.tournament_id == Tournament.id)
            .join(TournamentEntry, TournamentEntry.event_id == TournamentEvent.id)
            .where(TournamentEntry.id == entry_id)
        )
    ).scalar_one()
    await close_registration(db, entry_id, actor_id, WithdrawalReason.director_removal)
    await db.execute(
        update(TournamentEntry)
        .where(TournamentEntry.id == entry_id)
        .values(status=TournamentEntryStatus.withdrawn)
    )

    from app.event_lifecycle import reconcile_event

    event_id = await db.scalar(
        select(TournamentEntry.event_id).where(TournamentEntry.id == entry_id)
    )
    assert event_id is not None
    await reconcile_event(db, event_id)
