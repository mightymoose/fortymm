"""Adoption: a guest account that signs in to another account hands that
account everything it owns.
"""

from sqlalchemy import Uuid, column, select, table, update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId
from fortymm_api.models import Account, PlayerManager
from fortymm_api.ownership import OWNERSHIP_RULES, OwnershipRule
from fortymm_api.services.sessions import convert_guest

# hand_over_players() moves these, because they also change kind.
PLAYER_MANAGERS = ("player_managers", "account_id")


def hand_over_players(session: Session, guest: AccountId, into: AccountId) -> None:
    """Give `into` every player the guest account manages, each as `managed`
    with `adopted_from` set to the guest account.

    Sets up "Is this you?": a guest's self player could be a child who played
    on a parent's computer. Verify in place passes the guest account as
    `into`.
    """
    session.execute(
        update(PlayerManager)
        .where(PlayerManager.account_id == guest)
        .values(account_id=into, relationship="managed", adopted_from=guest)
    )


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
