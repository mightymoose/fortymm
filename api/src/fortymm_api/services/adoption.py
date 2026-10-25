"""Adoption: a guest account that signs in to another account hands that
account everything it owns.
"""

from sqlalchemy import update
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId
from fortymm_api.models import PlayerManager


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
