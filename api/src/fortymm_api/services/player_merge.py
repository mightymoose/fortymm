"""Player merge: two players that turn out to be one person become one.

The original player, the one created first, survives. It keeps its id and
display name. The other player gets `merged_into` set and gives up its
display name. Players are permanent, so its row stays.
"""

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import Player, PlayerManager


def merge_into_self(session: Session, account: AccountId, player: PlayerId) -> PlayerId:
    """Merge `player` and the account's self player. Returns the survivor.

    The caller holds the account's player_managers rows FOR UPDATE. The
    survivor becomes the account's self player. The account's row for the
    merged player stays, as `managed` (STAYS_ON_PLAYER_MERGE).
    """
    self_player = session.scalar(
        select(PlayerManager.player_id).where(
            PlayerManager.account_id == account, PlayerManager.relationship == "self"
        )
    )
    if self_player is None:
        raise ValueError(f"Account {account} has no self player")
    # FOR UPDATE on both players, so two merges of one player take turns.
    survivor, merged = session.scalars(
        select(Player.id)
        .where(Player.id.in_([self_player, player]))
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
    for found, relationship in ((merged, "managed"), (survivor, "self")):
        session.execute(
            update(PlayerManager)
            .where(
                PlayerManager.account_id == account, PlayerManager.player_id == found
            )
            .values(relationship=relationship, adopted_from=None)
        )
    return survivor
