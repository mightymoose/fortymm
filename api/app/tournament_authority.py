"""Tournament authority and delegation, with changes serialized against operations.

Internal operations use the caller's transaction; HTTP and MCP do not expose grant
management. Ownership and creator attribution are independent of delegated roles.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import ColumnElement, DateTime, and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Account, Tournament
from app.models.tournament_account_grant import (
    AuthorityChangeReason,
    TournamentAccountGrant,
    TournamentAccountRole,
    TournamentOwnershipTransfer,
)
from app.tournament_errors import NotTournamentOwnerError, TournamentNotFoundError


def director_scope(account_id: uuid.UUID) -> ColumnElement[bool]:
    """SQL predicate shared by operational writes and match read flags."""
    return and_(
        select(Account.id).where(Account.id == account_id, Account.is_active).exists(),
        or_(
            Tournament.owner_account_id == account_id,
            select(TournamentAccountGrant.id)
            .where(
                TournamentAccountGrant.tournament_id == Tournament.id,
                TournamentAccountGrant.account_id == account_id,
                TournamentAccountGrant.role == TournamentAccountRole.director,
                TournamentAccountGrant.revoked_at.is_(None),
            )
            .exists(),
        ),
    )


async def can_direct(
    db: AsyncSession, tournament: Tournament, account_id: uuid.UUID
) -> bool:
    return (
        await db.scalar(
            select(Tournament.id).where(
                Tournament.id == tournament.id, director_scope(account_id)
            )
        )
        is not None
    )


async def lock_tournament(db: AsyncSession, tournament_id: uuid.UUID) -> Tournament:
    tournament = await db.scalar(
        select(Tournament)
        .where(Tournament.id == tournament_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if tournament is None:
        raise TournamentNotFoundError()
    return tournament


async def grant_director(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    actor_id: uuid.UUID,
    account_id: uuid.UUID,
) -> TournamentAccountGrant:
    await _lock_accounts(db, actor_id, account_id)
    tournament = await lock_tournament(db, tournament_id)
    await require_owner(db, tournament, actor_id)
    grant = TournamentAccountGrant(
        tournament_id=tournament_id,
        account_id=account_id,
        granted_by_account_id=actor_id,
    )
    db.add(grant)
    await db.flush()
    return grant


async def revoke_director(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    actor_id: uuid.UUID,
    grant_id: uuid.UUID,
) -> None:
    recipient_id = await db.scalar(
        select(TournamentAccountGrant.account_id).where(
            TournamentAccountGrant.id == grant_id,
            TournamentAccountGrant.tournament_id == tournament_id,
        )
    )
    # Discovery does not authorize: reread the immutable grant under the parent
    # after locking its Account, so merge never meets a reversed lock order.
    await _lock_accounts(
        db,
        actor_id,
        *(() if recipient_id is None else (recipient_id,)),
        require_active=False,
    )
    tournament = await lock_tournament(db, tournament_id)
    await require_owner(db, tournament, actor_id)
    grant = await db.scalar(
        select(TournamentAccountGrant)
        .where(
            TournamentAccountGrant.id == grant_id,
            TournamentAccountGrant.tournament_id == tournament_id,
        )
        .execution_options(populate_existing=True)
    )
    if grant is None:
        raise ValueError("Grant does not belong to this tournament")
    if grant.revoked_at is None:
        grant.revoked_at = await _database_instant(db)
        grant.revoked_by_account_id = actor_id
        grant.revocation_reason = AuthorityChangeReason.explicit
        await db.flush()


@dataclass(frozen=True)
class AuthorityHistory:
    grants: tuple[TournamentAccountGrant, ...]
    transfers: tuple[TournamentOwnershipTransfer, ...]


async def authority_history(
    db: AsyncSession, tournament_id: uuid.UUID
) -> AuthorityHistory:
    grants = await db.scalars(
        select(TournamentAccountGrant)
        .where(TournamentAccountGrant.tournament_id == tournament_id)
        .order_by(TournamentAccountGrant.granted_at, TournamentAccountGrant.id)
    )
    transfers = await db.scalars(
        select(TournamentOwnershipTransfer)
        .where(TournamentOwnershipTransfer.tournament_id == tournament_id)
        .order_by(TournamentOwnershipTransfer.revision)
    )
    return AuthorityHistory(grants=tuple(grants), transfers=tuple(transfers))


async def require_owner(
    db: AsyncSession, tournament: Tournament, actor_id: uuid.UUID
) -> None:
    if tournament.owner_account_id != actor_id or not await can_direct(
        db, tournament, actor_id
    ):
        raise NotTournamentOwnerError()


async def transfer_ownership(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    actor_id: uuid.UUID,
    account_id: uuid.UUID,
) -> None:
    await _lock_accounts(db, actor_id, account_id)
    tournament = await lock_tournament(db, tournament_id)
    await require_owner(db, tournament, actor_id)
    if tournament.owner_account_id == account_id:
        return
    db.add(
        TournamentOwnershipTransfer(
            tournament_id=tournament_id,
            previous_owner_account_id=tournament.owner_account_id,
            new_owner_account_id=account_id,
            actor_account_id=actor_id,
            reason=AuthorityChangeReason.explicit,
        )
    )
    await db.flush()
    await db.refresh(
        tournament, attribute_names=["owner_account_id", "ownership_revision"]
    )


async def _lock_accounts(
    db: AsyncSession, *account_ids: uuid.UUID, require_active: bool = True
) -> None:
    # Match/entry writers and merge use the same Account -> Tournament order.
    accounts = list(
        await db.scalars(
            select(Account)
            .where(Account.id.in_(account_ids))
            .order_by(Account.id)
            .with_for_update(read=True, key_share=True)
            .execution_options(populate_existing=True)
        )
    )
    if len(accounts) != len(set(account_ids)) or (
        require_active and any(not account.is_active for account in accounts)
    ):
        raise ValueError("Authority requires active accounts")


async def merge_authority(
    db: AsyncSession, *, source_id: uuid.UUID, target_id: uuid.UUID
) -> None:
    """Carry current authority forward with honest system provenance.

    Caller holds both Accounts and the sorted union of affected tournaments.
    """
    source_grants = select(TournamentAccountGrant.tournament_id).where(
        TournamentAccountGrant.account_id == source_id,
        TournamentAccountGrant.revoked_at.is_(None),
    )
    tournaments = list(
        await db.scalars(
            select(Tournament)
            .where(
                or_(
                    Tournament.owner_account_id == source_id,
                    Tournament.id.in_(source_grants),
                )
            )
            .order_by(Tournament.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    for tournament in tournaments:
        if tournament.owner_account_id == source_id:
            db.add(
                TournamentOwnershipTransfer(
                    tournament_id=tournament.id,
                    previous_owner_account_id=source_id,
                    new_owner_account_id=target_id,
                    actor_account_id=None,
                    reason=AuthorityChangeReason.account_merge,
                )
            )
            await db.flush()
            await db.refresh(
                tournament, attribute_names=["owner_account_id", "ownership_revision"]
            )
        grants = list(
            await db.scalars(
                select(TournamentAccountGrant).where(
                    TournamentAccountGrant.tournament_id == tournament.id,
                    TournamentAccountGrant.account_id == source_id,
                    TournamentAccountGrant.revoked_at.is_(None),
                )
            )
        )
        for grant in grants:
            instant = await _database_instant(db)
            grant.revoked_at = instant
            grant.revocation_reason = AuthorityChangeReason.account_merge
            existing = await db.scalar(
                select(TournamentAccountGrant.id).where(
                    TournamentAccountGrant.tournament_id == tournament.id,
                    TournamentAccountGrant.account_id == target_id,
                    TournamentAccountGrant.role == grant.role,
                    TournamentAccountGrant.revoked_at.is_(None),
                )
            )
            if existing is None:
                db.add(
                    TournamentAccountGrant(
                        tournament_id=tournament.id,
                        account_id=target_id,
                        role=grant.role,
                        granted_by_account_id=None,
                        reason=AuthorityChangeReason.account_merge,
                        inherited_from_grant_id=grant.id,
                        granted_at=instant,
                    )
                )
    await db.flush()


async def lock_merge_tournaments(
    db: AsyncSession, *, source_id: uuid.UUID, target_id: uuid.UUID
) -> None:
    """Lock the complete union once; separate authority/sporting passes can deadlock.

    Both Accounts are already locked by merge_user, preventing concurrent grants
    or entries through these Accounts from widening the set after discovery.
    """
    await db.execute(
        text("""
        WITH RECURSIVE identities(id) AS (
            SELECT player_id FROM account_players
                WHERE account_id IN (:source, :target) AND is_primary
                        UNION SELECT p.id FROM players p JOIN identities i ON
            p.merged_into_player_id = i.id
        ), affected AS (
            SELECT DISTINCT e.tournament_id FROM identities i
            JOIN tournament_entry_members m ON m.player_id = i.id
            JOIN tournament_entries en ON en.id = m.entry_id
            JOIN tournament_events e ON e.id = en.event_id
            UNION SELECT id FROM tournaments WHERE owner_account_id = :source
            UNION SELECT tournament_id FROM tournament_account_grants
                WHERE account_id = :source AND revoked_at IS NULL
        )
        SELECT t.id FROM tournaments t JOIN affected a ON a.tournament_id = t.id
        ORDER BY t.id FOR UPDATE OF t
    """),
        {"source": source_id, "target": target_id},
    )


async def _database_instant(db: AsyncSession) -> datetime:
    return (
        await db.execute(select(func.clock_timestamp(type_=DateTime(timezone=True))))
    ).scalar_one()
