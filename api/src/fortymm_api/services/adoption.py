"""Adoption: a guest account that signs in to another account hands that
account everything it owns.
"""

from sqlalchemy import Uuid, column, select, table, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import Account, PlayerManager
from fortymm_api.ownership import OWNERSHIP_RULES, OwnershipRule
from fortymm_api.services.player_matches import has_played
from fortymm_api.services.player_merge import PlayedEachOther, merge_players
from fortymm_api.services.sessions import convert_guest

# hand_over_players() moves these, because they also change kind.
PLAYER_MANAGERS = ("player_managers", "account_id")


def has_activity(session: Session, player: PlayerId) -> bool:
    """Whether the player has played: whether it's in a match, with a result
    or not."""
    return has_played(session, player)


def hand_over_players(session: Session, guest: AccountId, into: AccountId) -> None:
    """Give `into` every player the guest account manages. Verify in place
    passes the guest account as `into`.

    A player that has played becomes `managed`, with `adopted_from` set to
    the guest account. That sets up "Is this you?": a guest's player could be
    a child who played on a parent's computer.

    A player that hasn't played asks nothing. Verify in place keeps it as it
    is, so the guest keeps its player and name. Adoption merges a self
    player into the self player of `into`, as "Yes" would, or makes it the
    self player of `into` if it has none. A managed one stays managed. If
    the two self players played each other, they can't merge, so the
    guest's one asks "Is this you?" as a player that has played does.
    """
    # start_session() and another adoption can give `into` a self player
    # meanwhile, and a row lock can't see a row that moves in. Both lock
    # this account row first.
    session.execute(select(Account.id).where(Account.id == into).with_for_update())
    # merge_players() needs the rows of `into` held FOR UPDATE.
    held = session.execute(
        select(PlayerManager.player_id, PlayerManager.relationship)
        .where(PlayerManager.account_id == into)
        .with_for_update()
    ).all()
    self_player = next(
        (player for player, relationship in held if relationship == "self"), None
    )
    rows = session.execute(
        select(PlayerManager.player_id, PlayerManager.relationship)
        .where(PlayerManager.account_id == guest)
        .order_by(PlayerManager.id)
    ).all()
    for player, relationship in rows:
        row = update(PlayerManager).where(
            PlayerManager.account_id == guest, PlayerManager.player_id == player
        )
        if has_activity(session, player):
            session.execute(
                row.values(account_id=into, relationship="managed", adopted_from=guest)
            )
        elif guest == into:
            continue
        elif relationship == "self" and self_player is not None:
            # The self index isn't deferrable, so the row moves as managed
            # before the merge picks the survivor's relationship.
            session.execute(row.values(account_id=into, relationship="managed"))
            try:
                merge_players(session, into, player, self_player)
            except PlayedEachOther:
                # A sign-in never fails over it. The account answers "Is
                # this you?" instead.
                session.execute(
                    update(PlayerManager)
                    .where(
                        PlayerManager.account_id == into,
                        PlayerManager.player_id == player,
                    )
                    .values(adopted_from=guest)
                )
        else:
            session.execute(row.values(account_id=into))


def adopt_guest(session: Session, guest: AccountId, into: AccountId) -> str:
    """Move everything the guest account owns to `into`, and give the browser
    that signed in a session for `into`. Returns its token.

    The guest account row stays, with `adopted_into` set, so its sessions
    are invalid and what still names it can find its new owner.
    """
    # A write as the guest account holds FOR SHARE, so this waits for it. A
    # write that starts later waits here, then finds adopted_into set.
    session.execute(select(Account.id).where(Account.id == guest).with_for_update())
    hand_over_players(session, guest, into)
    for key, rule in OWNERSHIP_RULES.items():
        if rule is not OwnershipRule.MOVES_ON_ADOPT or key == PLAYER_MANAGERS:
            continue
        table_name, column_name = key
        owner = column(column_name, Uuid)
        session.execute(
            update(table(table_name, owner))
            .where(owner == guest)
            .values({column_name: into})
        )
    token = convert_guest(session, guest, into)
    session.execute(
        update(Account).where(Account.id == guest).values(adopted_into=into)
    )
    return token
