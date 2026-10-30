"""Player merge: two players that turn out to be one person become one.

The original player, the one created first, survives. It keeps its id and
display name. The other player gets `merged_into` set and gives up its
display name. Players are permanent, so its row stays.
"""

from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import Player, PlayerManager


@dataclass(frozen=True)
class Merged:
    survivor: PlayerId
    merged: PlayerId


def merge_players(
    session: Session, account: AccountId, player: PlayerId, into: PlayerId
) -> Merged:
    """Merge `player` and `into`, two players the account manages.

    The caller holds the account's player_managers rows FOR UPDATE. The
    survivor's row takes the relationship that `into`'s row had, so a merge
    into the self player keeps the account's self player. The account's row
    for the merged player stays, as `managed` (STAYS_ON_PLAYER_MERGE).
    """
    relationship = session.scalar(
        select(PlayerManager.relationship).where(
            PlayerManager.account_id == account, PlayerManager.player_id == into
        )
    )
    if relationship is None:
        raise ValueError(f"Account {account} doesn't manage player {into}")
    # FOR UPDATE on both players, so two merges of one player take turns.
    survivor, merged = session.scalars(
        select(Player.id)
        .where(Player.id.in_([into, player]))
        # Players made in one transaction share created_at, so id breaks a tie.
        .order_by(Player.created_at, Player.id)
        .with_for_update()
    ).all()

    session.execute(
        update(Player)
        .where((Player.id == merged) | (Player.merged_into == merged))
        .values(merged_into=survivor)
    )
    # Each statement runs alone, because the self indexes aren't deferrable:
    # the old self row stops being 'self' before the survivor's row starts.
    for found, becomes in ((merged, "managed"), (survivor, relationship)):
        session.execute(
            update(PlayerManager)
            .where(
                PlayerManager.account_id == account, PlayerManager.player_id == found
            )
            .values(relationship=becomes, adopted_from=None)
        )
    return Merged(survivor, merged)
