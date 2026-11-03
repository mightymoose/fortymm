"""Device signing keys. Each device holds a P-256 key, and the account it
signs for holds the public half, so a signed result's kid names an account
(#188).

A key belongs to one account for good. Adoption moves it to the adopting
account (MOVES_ON_ADOPT), and nothing else changes its owner.

A live key has neither signed_out_at nor revoked_at. Signing out and the cap
end a key's life on its device, but what it signed still verifies. A device
that registers its key again, with a fresh proof, is back, so the key is
live again. Revoking says the device may be in the wrong hands. Its own
account or an administrator does it. The key verifies nothing more, not even
what it signed before, and nothing brings it back. The row names who revoked
it.

This module is the only writer of signed_out_at, revoked_at and revoked_by.
"""

import unicodedata
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Final

from sqlalchemy import (
    ColumnElement,
    and_,
    case,
    func,
    literal,
    null,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, Email
from fortymm_api.models import Account, Player, PlayerManager, SigningKey
from fortymm_api.services.sessions import (
    end_session,
    lock_account_for_write,
    session_account,
)
from fortymm_api.signing_keys import InvalidKey, KeyId, SigningPublicKey

# After a registration, the account has at most this many live keys: the new
# one and the newest LIVE_KEY_LIMIT - 1 others. An adoption can bring it
# more, which its next registration signs out.
LIVE_KEY_LIMIT: Final = 20
# The CHECK label_length repeats it.
LABEL_MAX_LENGTH: Final = 50
# The admin list holds at most this many keys.
KEY_PAGE_SIZE: Final = 50


class KeyState(StrEnum):
    """A key's state. Nothing stores it: _state() derives it."""

    LIVE = "live"
    SIGNED_OUT = "signed_out"
    REVOKED = "revoked"


@dataclass(frozen=True)
class AccountSigningKey:
    """A key, as the account that owns it sees it."""

    id: KeyId
    label: str
    created_at: datetime
    signed_out_at: datetime | None
    revoked_at: datetime | None


@dataclass(frozen=True)
class VerificationKey:
    """A key that verifies signatures, the account they speak for, and when
    its device signed out, if it has. Results from a hall upload late, so a
    signature after the sign-out still verifies. #188 decides what it is
    worth."""

    public_key: SigningPublicKey
    account: AccountId
    signed_out_at: datetime | None


@dataclass(frozen=True)
class KeyAccount:
    """The account a key signs for, as the admin list shows it."""

    id: AccountId
    # None for a guest.
    email: Email | None
    # The account's self player's name. None for the moment between a
    # sign-in that makes the account and its first POST /v1/session.
    display_name: str | None


@dataclass(frozen=True)
class Revocation:
    """When a key was revoked, and by whom."""

    at: datetime
    # The key's own account, or an administrator's.
    by: AccountId
    # None only when `by` is a guest, which can only be the key's own account.
    by_email: Email | None


@dataclass(frozen=True)
class AdminSigningKey:
    """A key, as an administrator sees it."""

    id: KeyId
    label: str
    created_at: datetime
    state: KeyState
    signed_out_at: datetime | None
    revocation: Revocation | None
    account: KeyAccount


@dataclass(frozen=True)
class KeyPage:
    keys: list[AdminSigningKey]
    # More keys match than the page holds.
    has_more: bool


class InvalidDeviceLabel(Exception):
    """The label is empty, longer than LABEL_MAX_LENGTH after trimming, or
    holds a control character. `create_app()` answers 422."""


class InvalidPublicKey(Exception):
    """The public key isn't a P-256 COSE_Key in the format's encoding.
    `create_app()` answers 422."""


class InvalidProof(Exception):
    """The proof isn't the key's registration proof for this account: another
    key, another account, a bad signature or bytes that aren't the format.
    `create_app()` answers 422."""


class KeyRegisteredElsewhere(Exception):
    """Another account owns the key. `create_app()` answers 409."""


class SigningKeyNotFound(Exception):
    """The account owns no key with the id. `create_app()` answers 404."""


class UnknownSigningKey(Exception):
    """No key has the id. `create_app()` answers 404."""


def register_key(
    session: Session,
    account: AccountId,
    *,
    public_key: bytes,
    proof: bytes,
    label: str,
) -> AccountSigningKey:
    """Register a device's key to the account, and return it.

    `public_key` is the key's COSE_Key, `proof` the registration proof the
    key signed for this account, and `label` the device's name. The label is
    trimmed.

    Registering a key the account already owns returns it with its label
    and created_at as they were, so a retry gets the first call's answer. A
    signed-out key is live again: the fresh proof shows the device is back.
    A revoked key stays as it is, signed out or not. A key that another
    account owns raises KeyRegisteredElsewhere.

    A registration that leaves the key live signs out the account's oldest
    live keys (by created_at, then id) past LIVE_KEY_LIMIT. Nothing is
    refused for the cap.

    Raises InvalidDeviceLabel, InvalidPublicKey and InvalidProof, in that
    order, before any read. So a caller that doesn't hold the private key
    learns nothing about the key, not even whose it is.
    """
    label = _device_label(label)
    try:
        key = SigningPublicKey.from_cose_key(public_key)
    except InvalidKey as error:
        raise InvalidPublicKey from error
    if not key.verify_registration(proof, account):
        raise InvalidProof
    lock_account_for_write(session, account, exclusive=True)

    # The insert, not a read before it, is where two accounts that register
    # one key meet: they hold different account locks. ON CONFLICT waits for
    # the other's commit, then does nothing.
    row = session.scalar(
        insert(SigningKey)
        .values(
            id=key.kid, public_key=key.to_cose_key(), account_id=account, label=label
        )
        .on_conflict_do_nothing(index_elements=[SigningKey.id])
        .returning(SigningKey)
    )
    if row is None:
        row = session.scalar(
            update(SigningKey)
            .where(SigningKey.id == key.kid, SigningKey.account_id == account)
            .values(
                signed_out_at=case(
                    (SigningKey.revoked_at.is_(None), null()),
                    else_=SigningKey.signed_out_at,
                )
            )
            .returning(SigningKey)
        )
        if row is None:
            raise KeyRegisteredElsewhere
    if row.revoked_at is None:
        _sign_out(session, _past_the_cap(account, keeping=row.id))
    return _account_key(row)


def account_keys(session: Session, account: AccountId) -> list[AccountSigningKey]:
    """Every key the account owns, newest first (created_at, then id): live,
    signed out and revoked."""
    rows = session.scalars(
        select(SigningKey)
        .where(SigningKey.account_id == account)
        .order_by(SigningKey.created_at.desc(), SigningKey.id.desc())
    )
    return [_account_key(row) for row in rows]


def revoke_key(session: Session, account: AccountId, key: KeyId) -> AccountSigningKey:
    """Report the key's device compromised, as the account that owns it.
    From now on the key verifies nothing, so #188 refuses what it signs as
    unknown_key. Returns the key.

    Revoking a revoked key changes nothing: revoked_at and revoked_by keep
    their first values. A signed-out key can be revoked. Raises
    SigningKeyNotFound unless the account owns the key, so another account's
    key looks like no key.
    """
    lock_account_for_write(session, account)
    row = _revoke(
        session, (SigningKey.id == key) & (SigningKey.account_id == account), account
    )
    if row is None:
        raise SigningKeyNotFound
    return _account_key(row)


def find_keys(session: Session, search: str = "") -> KeyPage:
    """Every account's keys, guests' too, in every state, newest first
    (created_at, then id). At most KEY_PAGE_SIZE.

    `search` keeps the keys whose account's email, or whose account's self
    player's name, contains it, whatever its case. `%` and `_` match
    themselves.
    """
    text = search.strip().lower()
    where = []
    # Left out for empty text: a guest's email is NULL, and strpos(NULL, '')
    # is NULL, so the predicate would drop every guest.
    if text:
        where.append(
            or_(
                func.strpos(Account.email, text) > 0,
                func.strpos(func.lower(Player.display_name), text) > 0,
            )
        )
    found = _admin_keys(session, *where, limit=KEY_PAGE_SIZE + 1)
    return KeyPage(found[:KEY_PAGE_SIZE], has_more=len(found) > KEY_PAGE_SIZE)


def revoke_any_key(session: Session, actor: AccountId, key: KeyId) -> AdminSigningKey:
    """An administrator revokes any account's key, a guest's too. From now
    on the key verifies nothing, not even what it signed before. Results
    already accepted stay.

    The key's account keeps its sessions. Its device finds out at its next
    registration and makes a new key. Revoking a revoked key changes
    nothing: revoked_at and revoked_by keep their first values. Raises
    UnknownSigningKey if no key has the id.

    It locks the actor, whom it records, but not the key's account: the
    UPDATE's row lock already takes turns with adoption, register_key and a
    sign-out. An owner lock would answer an administrator 401 for a key that
    adoption just moved.
    """
    lock_account_for_write(session, actor)
    if _revoke(session, SigningKey.id == key, actor) is None:
        raise UnknownSigningKey
    # Read back, so the answer names the key's account as of the revoke.
    return _admin_keys(session, SigningKey.id == key)[0]


def sign_out_device(session: Session, token: str | None, key: KeyId | None) -> None:
    """Sign a device out: sign out `key` if the account of the session the
    token names owns it, then end the session.

    A key that is None, unknown, another account's or already signed out
    changes nothing, so a sign-out never fails over its key. A signed-out key
    still verifies what it signed.

    It takes no account lock. The key goes before the session because
    adoption moves a guest's keys before it deletes its sessions. In the
    other order, a logout that overlaps an adoption deadlocks with it. In
    this order it waits, then finds the key on another account and skips it,
    as it skips any other account's key.
    """
    owner = session_account(session, token)
    if owner is not None and key is not None:
        _sign_out(session, (SigningKey.id == key) & (SigningKey.account_id == owner))
    end_session(session, token)


def verification_keys(
    session: Session, kids: Collection[KeyId]
) -> dict[KeyId, VerificationKey]:
    """The keys among `kids` that verify, by kid, each with the account its
    signatures speak for and when its device signed out, if it has: every
    registered key that isn't revoked, signed out or not. A kid missing from
    the result is unknown or revoked. UnverifiedEnvelope.verify() refuses
    either as unknown_key.
    """
    rows = session.execute(
        select(
            SigningKey.public_key, SigningKey.account_id, SigningKey.signed_out_at
        ).where(SigningKey.id.in_(kids), SigningKey.revoked_at.is_(None))
    )
    keys = (
        VerificationKey(SigningPublicKey.from_cose_key(cose_key), owner, signed_out_at)
        for cose_key, owner, signed_out_at in rows
    )
    return {key.public_key.kid: key for key in keys}


def _device_label(label: str) -> str:
    """The label trimmed, or InvalidDeviceLabel unless 1 to LABEL_MAX_LENGTH
    characters remain, none of them a control character (Unicode category
    Cc: C0, DEL and C1). str.strip() trims every Unicode space, more than
    the CHECK's btrim(), so a label it passes always meets the CHECK."""
    label = label.strip()
    if not 1 <= len(label) <= LABEL_MAX_LENGTH:
        raise InvalidDeviceLabel
    if any(unicodedata.category(c) == "Cc" for c in label):
        raise InvalidDeviceLabel
    return label


def _state() -> ColumnElement[str]:
    """The one rule for a key's state: revoked wins over signed out, which
    wins over live."""
    return case(
        (SigningKey.revoked_at.is_not(None), KeyState.REVOKED.value),
        (SigningKey.signed_out_at.is_not(None), KeyState.SIGNED_OUT.value),
        else_=KeyState.LIVE.value,
    )


def _live() -> ColumnElement[bool]:
    return _state() == KeyState.LIVE.value


def _revoke(
    session: Session, which: ColumnElement[bool], by: AccountId
) -> SigningKey | None:
    """Revoke the key `which` selects, as `by`, and return its row, or None
    if no key matches. SET reads the row as it was before the update, so a
    revoked key keeps its first time and its first revoker together."""
    return session.scalar(
        update(SigningKey)
        .where(which)
        .values(
            revoked_at=func.coalesce(SigningKey.revoked_at, func.now()),
            revoked_by=case(
                (
                    SigningKey.revoked_at.is_(None),
                    literal(by, SigningKey.revoked_by.type),
                ),
                else_=SigningKey.revoked_by,
            ),
        )
        .returning(SigningKey)
    )


def _admin_keys(
    session: Session, *where: ColumnElement[bool], limit: int | None = None
) -> list[AdminSigningKey]:
    """The keys `where` selects, newest first, each with its account, the
    account's self player's name and its revoker. `where` may name Account
    (the key's account) and Player (its self player)."""
    revoker = aliased(Account)
    query = (
        select(
            SigningKey.id,
            SigningKey.label,
            SigningKey.created_at,
            _state(),
            SigningKey.signed_out_at,
            SigningKey.revoked_at,
            SigningKey.revoked_by,
            revoker.email,
            Account.id,
            Account.email,
            Player.display_name,
        )
        .join(Account, Account.id == SigningKey.account_id)
        .outerjoin(
            PlayerManager,
            and_(
                PlayerManager.account_id == Account.id,
                PlayerManager.relationship == "self",
            ),
        )
        .outerjoin(Player, Player.id == PlayerManager.player_id)
        .outerjoin(revoker, revoker.id == SigningKey.revoked_by)
        .where(*where)
        .order_by(SigningKey.created_at.desc(), SigningKey.id.desc())
        .limit(limit)
    )
    return [
        AdminSigningKey(
            id,
            label,
            created_at,
            KeyState(state),
            signed_out_at,
            None
            if revoked_at is None or revoked_by is None
            else Revocation(revoked_at, revoked_by, revoked_by_email),
            KeyAccount(account_id, email, display_name),
        )
        for (
            id,
            label,
            created_at,
            state,
            signed_out_at,
            revoked_at,
            revoked_by,
            revoked_by_email,
            account_id,
            email,
            display_name,
        ) in session.execute(query)
    ]


def _past_the_cap(account: AccountId, keeping: KeyId) -> ColumnElement[bool]:
    """The account's live keys that the cap signs out: every one but
    `keeping` and the newest LIVE_KEY_LIMIT - 1 others.

    One predicate from the current rows, not a count: it restores the
    invariant from any state, so keys that adoption moved in are trimmed on
    the next registration too.
    """
    # `keeping` is left out by id, not by its created_at: now() is the
    # transaction's start, so a registration that waited for the lock can
    # carry an older time than keys registered meanwhile.
    others = (SigningKey.account_id == account) & _live() & (SigningKey.id != keeping)
    newest = (
        select(SigningKey.id)
        .where(others)
        .order_by(SigningKey.created_at.desc(), SigningKey.id.desc())
        .limit(LIVE_KEY_LIMIT - 1)
        .correlate(None)
    )
    return others & SigningKey.id.not_in(newest)


def _sign_out(session: Session, keys: ColumnElement[bool]) -> None:
    """Set signed_out_at on the keys `keys` selects that have none. The cap
    and a device's sign-out both come here, so the first time sticks."""
    session.execute(
        update(SigningKey)
        .where(keys, SigningKey.signed_out_at.is_(None))
        .values(signed_out_at=func.now())
        .execution_options(synchronize_session=False)
    )


def _account_key(row: SigningKey) -> AccountSigningKey:
    return AccountSigningKey(
        row.id, row.label, row.created_at, row.signed_out_at, row.revoked_at
    )
