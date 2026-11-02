"""Device signing keys. Each device holds a P-256 key, and the account it
signs for holds the public half, so a signed result's kid names an account
(#188).

A key belongs to one account for good. Adoption moves it to the adopting
account (MOVES_ON_ADOPT), and nothing else changes its owner.

A live key has neither signed_out_at nor revoked_at. Signing out and the cap
end a key's life on its device, but what it signed still verifies. Revoking
says the device was compromised: the key verifies nothing more.

This module is the only writer of signed_out_at and revoked_at.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from fortymm_api.accounts import AccountId
from fortymm_api.models import SigningKey
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
    """A key that verifies signatures, and the account they speak for."""

    public_key: SigningPublicKey
    account: AccountId


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

    Registering a key the account already owns changes nothing and returns
    the key as it is, signed out or revoked included, so a retry gets the
    first call's answer. Its label stays. A key that another account owns
    raises KeyRegisteredElsewhere.

    A new key signs out the account's oldest live keys (by created_at, then
    id) past LIVE_KEY_LIMIT. Nothing is refused for the cap.

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
        existing = session.scalars(
            select(SigningKey).where(SigningKey.id == key.kid)
        ).one()
        if existing.account_id != account:
            raise KeyRegisteredElsewhere
        return _account_key(existing)
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
    """Report the key's device compromised. From now on the key verifies
    nothing, so #188 refuses what it signs as unknown_key. Returns the key.

    Revoking a revoked key changes nothing: revoked_at keeps its first time.
    A signed-out key can be revoked. Raises SigningKeyNotFound unless the
    account owns the key, so another account's key looks like no key.
    """
    lock_account_for_write(session, account)
    row = session.scalar(
        update(SigningKey)
        .where(SigningKey.id == key, SigningKey.account_id == account)
        .values(revoked_at=func.coalesce(SigningKey.revoked_at, func.now()))
        .returning(SigningKey)
    )
    if row is None:
        raise SigningKeyNotFound
    return _account_key(row)


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
    signatures speak for: every registered key that isn't revoked, signed
    out or not. A kid missing from the result is unknown or revoked.
    UnverifiedEnvelope.verify() refuses either as unknown_key.
    """
    rows = session.execute(
        select(SigningKey.public_key, SigningKey.account_id).where(
            SigningKey.id.in_(kids), SigningKey.revoked_at.is_(None)
        )
    )
    keys = (
        VerificationKey(SigningPublicKey.from_cose_key(cose_key), owner)
        for cose_key, owner in rows
    )
    return {key.public_key.kid: key for key in keys}


def _device_label(label: str) -> str:
    """The label trimmed, or InvalidDeviceLabel unless 1 to LABEL_MAX_LENGTH
    characters remain, none of them a control character. str.strip() trims
    every Unicode space, more than the CHECK's btrim(), so a label it passes
    always meets the CHECK."""
    label = label.strip()
    if not 1 <= len(label) <= LABEL_MAX_LENGTH:
        raise InvalidDeviceLabel
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in label):
        raise InvalidDeviceLabel
    return label


def _live() -> ColumnElement[bool]:
    return SigningKey.signed_out_at.is_(None) & SigningKey.revoked_at.is_(None)


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
