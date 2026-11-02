import hashlib
import uuid
from collections.abc import Callable
from ipaddress import ip_address

import cbor2
import pytest
from locks import overlap, wait_behind
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, Email
from fortymm_api.models import Account
from fortymm_api.services import adoption
from fortymm_api.services.adoption import adopt_guest
from fortymm_api.services.sessions import (
    AccountAdopted,
    authenticate,
    convert_guest,
    new_session,
    start_session,
)
from fortymm_api.services.signing_keys import (
    LABEL_MAX_LENGTH,
    LIVE_KEY_LIMIT,
    AccountSigningKey,
    InvalidDeviceLabel,
    InvalidProof,
    InvalidPublicKey,
    KeyRegisteredElsewhere,
    SigningKeyNotFound,
    VerificationKey,
    account_keys,
    register_key,
    revoke_key,
    sign_out_device,
    verification_keys,
)
from fortymm_api.signing_keys import KeyId, SigningPrivateKey

ANN = ip_address("203.0.113.7")
LABEL = "Ann's phone"


def key(n: int) -> SigningPrivateKey:
    return SigningPrivateKey(hashlib.sha256(f"device key {n}".encode()).digest())


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def guest(database: Engine) -> AccountId:
    return in_transaction(
        database, lambda session: start_session(session, None, ANN).account.id
    )


def verified(database: Engine, email: str) -> AccountId:
    def add(session: Session) -> AccountId:
        account = Account(email=Email(email))
        session.add(account)
        session.flush()
        return account.id

    return in_transaction(database, add)


def register(
    database: Engine,
    account: AccountId,
    device: SigningPrivateKey,
    label: str = LABEL,
    *,
    proof: bytes | None = None,
    public_key: bytes | None = None,
) -> AccountSigningKey:
    return in_transaction(
        database,
        lambda session: register_key(
            session,
            account,
            public_key=device.public_key.to_cose_key()
            if public_key is None
            else public_key,
            proof=device.registration_proof(account) if proof is None else proof,
            label=label,
        ),
    )


def keys_of(database: Engine, account: AccountId) -> list[AccountSigningKey]:
    return in_transaction(database, lambda session: account_keys(session, account))


def live(keys: list[AccountSigningKey]) -> list[KeyId]:
    return [k.id for k in keys if k.signed_out_at is None and k.revoked_at is None]


def revoke(database: Engine, account: AccountId, kid: KeyId) -> AccountSigningKey:
    return in_transaction(database, lambda session: revoke_key(session, account, kid))


def session_token(database: Engine, account: AccountId) -> str:
    return in_transaction(database, lambda session: new_session(session, account)[1])


def sign_out(database: Engine, token: str | None, kid: KeyId | None) -> None:
    in_transaction(database, lambda session: sign_out_device(session, token, kid))


def signed_in(database: Engine, token: str) -> bool:
    return (
        in_transaction(database, lambda session: authenticate(session, token))
        is not None
    )


def verifying(database: Engine, *kids: KeyId) -> dict[KeyId, VerificationKey]:
    return in_transaction(database, lambda session: verification_keys(session, kids))


def created(database: Engine, kid: KeyId, *, days_ago: int) -> None:
    with database.begin() as connection:
        connection.execute(
            text(
                "UPDATE signing_keys"
                " SET created_at = now() - make_interval(days => :days)"
                " WHERE id = :id"
            ),
            {"id": kid, "days": days_ago},
        )


def fill_to_the_cap(
    database: Engine, account: AccountId, first: int = 0
) -> list[KeyId]:
    """Register LIVE_KEY_LIMIT keys, each a day newer than the one before."""
    kids = [
        register(database, account, key(first + n)).id for n in range(LIVE_KEY_LIMIT)
    ]
    for n, kid in enumerate(kids):
        created(database, kid, days_ago=LIVE_KEY_LIMIT - n)
    return kids


@pytest.mark.parametrize(
    ("label", "stored"),
    [
        ("  Ann's phone ", "Ann's phone"),
        ("x" * LABEL_MAX_LENGTH, "x" * LABEL_MAX_LENGTH),
        ("Ann\u2019s iPhone 15", "Ann\u2019s iPhone 15"),
    ],
    ids=["padded", "at the limit", "unicode"],
)
def test_a_new_key_is_registered_live_with_its_trimmed_label(
    migrated_database: Engine, label: str, stored: str
) -> None:
    account = guest(migrated_database)

    registered = register(migrated_database, account, key(1), label)

    assert registered.id == key(1).public_key.kid
    assert registered.label == stored
    assert registered.signed_out_at is None
    assert registered.revoked_at is None
    assert keys_of(migrated_database, account) == [registered]


def test_a_proof_for_another_account_is_refused(migrated_database: Engine) -> None:
    account, other = guest(migrated_database), guest(migrated_database)

    with pytest.raises(InvalidProof):
        register(
            migrated_database, account, key(1), proof=key(1).registration_proof(other)
        )

    assert keys_of(migrated_database, account) == []


def test_a_proof_by_another_key_is_refused(migrated_database: Engine) -> None:
    account = guest(migrated_database)

    with pytest.raises(InvalidProof):
        register(
            migrated_database, account, key(1), proof=key(2).registration_proof(account)
        )

    assert keys_of(migrated_database, account) == []


def test_a_proof_with_a_flipped_signature_bit_is_refused(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    proof = bytearray(key(1).registration_proof(account))
    proof[-1] ^= 1

    with pytest.raises(InvalidProof):
        register(migrated_database, account, key(1), proof=bytes(proof))

    assert keys_of(migrated_database, account) == []


def _as_cose_sign(proof: bytes) -> bytes:
    tagged = cbor2.loads(proof)
    return cbor2.dumps(cbor2.CBORTag(98, list(tagged.value)), canonical=True)


@pytest.mark.parametrize(
    "change",
    [
        lambda proof: b"",
        lambda proof: b"not a proof",
        lambda proof: proof[:-1],
        lambda proof: proof + b"\x00",
        _as_cose_sign,
    ],
    ids=["no bytes", "garbage", "truncated", "trailing byte", "tag 98"],
)
def test_a_malformed_proof_is_refused(
    migrated_database: Engine, change: Callable[[bytes], bytes]
) -> None:
    account = guest(migrated_database)

    with pytest.raises(InvalidProof):
        register(
            migrated_database,
            account,
            key(1),
            proof=change(key(1).registration_proof(account)),
        )

    assert keys_of(migrated_database, account) == []


@pytest.mark.parametrize(
    "public_key",
    [b"", b"\xa0", key(1).public_key.to_cose_key()[:74]],
    ids=["no bytes", "empty map", "truncated"],
)
def test_a_malformed_public_key_is_refused(
    migrated_database: Engine, public_key: bytes
) -> None:
    account = guest(migrated_database)

    with pytest.raises(InvalidPublicKey):
        register(migrated_database, account, key(1), public_key=public_key)

    assert keys_of(migrated_database, account) == []


@pytest.mark.parametrize(
    "label",
    [
        "",
        "   ",
        "\u2003",
        "x" * (LABEL_MAX_LENGTH + 1),
        "Ann\nphone",
        "Ann\x7f",
        "\x00",
        "Ann\x85phone",
        "Ann\u009f",
    ],
    ids=[
        "empty",
        "spaces",
        "unicode space",
        "over the limit",
        "newline",
        "delete",
        "nul",
        "next line",
        "c1 control",
    ],
)
def test_a_label_that_breaks_its_rule_is_refused(
    migrated_database: Engine, label: str
) -> None:
    account = guest(migrated_database)

    with pytest.raises(InvalidDeviceLabel):
        register(migrated_database, account, key(1), label)

    assert keys_of(migrated_database, account) == []


def test_registering_a_key_twice_returns_it_unchanged(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    first = register(migrated_database, account, key(1), "Ann's phone")

    again = register(migrated_database, account, key(1), "Ann's other phone")

    assert again == first
    assert keys_of(migrated_database, account) == [first]


def test_registering_a_signed_out_key_again_makes_it_live(
    migrated_database: Engine,
) -> None:
    """The device signed out and signed back in. Its fresh proof shows it is
    back, so the key is live again, with its label and created_at."""
    account = guest(migrated_database)
    first = register(migrated_database, account, key(1), "Ann's phone")
    sign_out(migrated_database, session_token(migrated_database, account), first.id)
    [signed_out] = keys_of(migrated_database, account)
    assert signed_out.signed_out_at is not None

    again = register(migrated_database, account, key(1), "Ann's other phone")

    assert again == first
    assert keys_of(migrated_database, account) == [first]


def test_a_key_that_comes_back_live_counts_against_the_cap(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    old = register(migrated_database, account, key(100)).id
    sign_out(migrated_database, session_token(migrated_database, account), old)
    created(migrated_database, old, days_ago=365)
    kids = fill_to_the_cap(migrated_database, account)

    revived = register(migrated_database, account, key(100))

    keys = keys_of(migrated_database, account)
    assert revived.signed_out_at is None
    assert set(live(keys)) == {*kids[1:], old}


def test_registering_a_revoked_key_again_keeps_it_revoked(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    kid = register(migrated_database, account, key(1)).id
    sign_out(migrated_database, session_token(migrated_database, account), kid)
    revoked = revoke(migrated_database, account, kid)
    assert revoked.signed_out_at is not None
    assert revoked.revoked_at is not None

    assert register(migrated_database, account, key(1)) == revoked
    assert keys_of(migrated_database, account) == [revoked]


def test_a_key_of_another_account_is_refused(migrated_database: Engine) -> None:
    account, other = guest(migrated_database), guest(migrated_database)
    theirs = register(migrated_database, other, key(1))

    with pytest.raises(KeyRegisteredElsewhere):
        register(migrated_database, account, key(1))

    assert keys_of(migrated_database, account) == []
    assert keys_of(migrated_database, other) == [theirs]


def test_a_replayed_proof_for_another_accounts_key_is_refused_as_invalid(
    migrated_database: Engine,
) -> None:
    """A caller without the private key learns nothing about the key, not
    even that another account owns it."""
    account, other = guest(migrated_database), guest(migrated_database)
    theirs = register(migrated_database, other, key(1))

    with pytest.raises(InvalidProof):
        register(
            migrated_database, account, key(1), proof=key(1).registration_proof(other)
        )

    assert keys_of(migrated_database, account) == []
    assert keys_of(migrated_database, other) == [theirs]


def test_two_accounts_that_register_one_key_at_once_take_turns(
    migrated_database: Engine,
) -> None:
    account, other = guest(migrated_database), guest(migrated_database)

    def registration(owner: AccountId) -> Callable[[Session], AccountSigningKey]:
        return lambda session: register_key(
            session,
            owner,
            public_key=key(1).public_key.to_cose_key(),
            proof=key(1).registration_proof(owner),
            label=LABEL,
        )

    theirs, waiter = wait_behind(
        migrated_database, registration(other), registration(account)
    )

    with pytest.raises(KeyRegisteredElsewhere):
        waiter.result()
    assert keys_of(migrated_database, account) == []
    assert keys_of(migrated_database, other) == [theirs]


def test_lists_the_accounts_keys_newest_first(migrated_database: Engine) -> None:
    account = guest(migrated_database)
    kids = [register(migrated_database, account, key(n)).id for n in range(3)]
    created(migrated_database, kids[1], days_ago=2)
    created(migrated_database, kids[0], days_ago=1)

    assert [k.id for k in keys_of(migrated_database, account)] == [
        kids[2],
        kids[0],
        kids[1],
    ]


def test_the_21st_key_signs_out_the_oldest_live_key(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    kids = fill_to_the_cap(migrated_database, account)

    newest = register(migrated_database, account, key(LIVE_KEY_LIMIT))

    keys = keys_of(migrated_database, account)
    assert len(keys) == LIVE_KEY_LIMIT + 1
    assert set(live(keys)) == {*kids[1:], newest.id}
    assert newest.signed_out_at is None


def test_the_cap_counts_only_live_keys(migrated_database: Engine) -> None:
    account = guest(migrated_database)
    token = session_token(migrated_database, account)
    gone = [register(migrated_database, account, key(n)).id for n in (100, 101)]
    sign_out(migrated_database, token, gone[0])
    revoke(migrated_database, account, gone[1])
    for kid in gone:
        created(migrated_database, kid, days_ago=365)
    before = {k.id: k for k in keys_of(migrated_database, account)}
    kids = fill_to_the_cap(migrated_database, account)

    newest = register(migrated_database, account, key(LIVE_KEY_LIMIT))

    after = {k.id: k for k in keys_of(migrated_database, account)}
    assert set(live(list(after.values()))) == {*kids[1:], newest.id}
    assert after[gone[0]] == before[gone[0]]
    assert after[gone[1]] == before[gone[1]]
    assert after[kids[0]].signed_out_at is not None


def test_a_key_registered_at_the_cap_is_kept_even_when_older(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    kids = fill_to_the_cap(migrated_database, account)
    # Every other key is dated after the new one's now(), as a registration
    # that waited for the account lock can find them.
    for n, kid in enumerate(kids):
        created(migrated_database, kid, days_ago=-(n + 1))

    newest = register(migrated_database, account, key(LIVE_KEY_LIMIT))

    keys = keys_of(migrated_database, account)
    assert set(live(keys)) == {*kids[1:], newest.id}


def test_two_registrations_at_once_leave_20_live_keys(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    kids = [
        register(migrated_database, account, key(n)).id
        for n in range(LIVE_KEY_LIMIT - 1)
    ]
    for n, kid in enumerate(kids):
        created(migrated_database, kid, days_ago=LIVE_KEY_LIMIT - n)

    def registration(n: int) -> Callable[[Session], AccountSigningKey]:
        return lambda session: register_key(
            session,
            account,
            public_key=key(n).public_key.to_cose_key(),
            proof=key(n).registration_proof(account),
            label=LABEL,
        )

    first, waiter = wait_behind(
        migrated_database,
        registration(LIVE_KEY_LIMIT - 1),
        registration(LIVE_KEY_LIMIT),
    )

    second = waiter.result()
    keys = keys_of(migrated_database, account)
    assert len(live(keys)) == LIVE_KEY_LIMIT
    assert set(live(keys)) == {*kids[1:], first.id, second.id}


def test_signing_out_a_device_ends_its_session_and_signs_out_its_key(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    kid = register(migrated_database, account, key(1)).id
    token = session_token(migrated_database, account)

    sign_out(migrated_database, token, kid)

    assert not signed_in(migrated_database, token)
    [signed_out] = keys_of(migrated_database, account)
    assert signed_out.signed_out_at is not None
    assert signed_out.revoked_at is None


def test_signing_out_ignores_a_key_the_session_s_account_does_not_hold_live(
    migrated_database: Engine,
) -> None:
    account, other = guest(migrated_database), guest(migrated_database)
    kid = register(migrated_database, account, key(1)).id
    theirs = register(migrated_database, other, key(2)).id
    sign_out(migrated_database, session_token(migrated_database, account), kid)
    before = keys_of(migrated_database, account), keys_of(migrated_database, other)

    for ignored in (None, KeyId(uuid.uuid4().bytes * 2), theirs, kid):
        token = session_token(migrated_database, account)
        sign_out(migrated_database, token, ignored)
        assert not signed_in(migrated_database, token)

    assert (keys_of(migrated_database, account), keys_of(migrated_database, other)) == (
        before
    )


def test_signing_out_without_a_session_changes_nothing(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    kid = register(migrated_database, account, key(1)).id
    before = keys_of(migrated_database, account)

    sign_out(migrated_database, None, kid)
    sign_out(migrated_database, "not a token", kid)

    assert keys_of(migrated_database, account) == before


def test_a_logout_that_overlaps_an_adoption_waits_for_it(
    migrated_database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Adoption moves the guest's keys, then deletes its sessions. A logout
    between the two must wait for it, not deadlock with it."""
    bob = verified(migrated_database, "bob@example.com")
    guest_account = guest(migrated_database)
    kid = register(migrated_database, guest_account, key(1)).id
    token = session_token(migrated_database, guest_account)

    def adoption_with_a_logout_between(
        session: Session, let_logout_wait: Callable[[], None]
    ) -> str:
        # adopt_guest() deletes the guest's sessions through convert_guest(),
        # after it moved the keys. The logout starts between the two.
        def convert_guest_after_the_logout(
            session: Session, guest: AccountId, into: AccountId
        ) -> str:
            let_logout_wait()
            return convert_guest(session, guest, into)

        monkeypatch.setattr(adoption, "convert_guest", convert_guest_after_the_logout)
        return adopt_guest(session, guest_account, bob)

    _, waiter = overlap(
        migrated_database,
        adoption_with_a_logout_between,
        lambda session: sign_out_device(session, token, kid),
    )

    waiter.result()
    [moved] = keys_of(migrated_database, bob)
    assert moved.id == kid
    assert moved.signed_out_at is None
    assert not signed_in(migrated_database, token)


def test_a_signed_out_key_still_verifies_for_its_account(
    migrated_database: Engine,
) -> None:
    """The verifier sees when the device signed out, so #188 can weigh a
    result signed after it. Results from a hall upload late, so it is told,
    not refused."""
    account = guest(migrated_database)
    kid = register(migrated_database, account, key(1)).id
    sign_out(migrated_database, session_token(migrated_database, account), kid)
    [signed_out] = keys_of(migrated_database, account)

    assert verifying(migrated_database, kid) == {
        kid: VerificationKey(key(1).public_key, account, signed_out.signed_out_at)
    }


def test_a_revoked_key_and_an_unknown_kid_do_not_verify(
    migrated_database: Engine,
) -> None:
    account = guest(migrated_database)
    kept = register(migrated_database, account, key(1)).id
    revoked = register(migrated_database, account, key(2)).id
    revoke(migrated_database, account, revoked)
    unknown = key(3).public_key.kid

    assert verifying(migrated_database, kept, revoked, unknown) == {
        kept: VerificationKey(key(1).public_key, account, None)
    }
    assert verifying(migrated_database) == {}


def test_revoking_twice_keeps_the_first_time(migrated_database: Engine) -> None:
    account = guest(migrated_database)
    kid = register(migrated_database, account, key(1)).id

    first = revoke(migrated_database, account, kid)
    again = revoke(migrated_database, account, kid)

    assert first.revoked_at is not None
    assert again == first
    assert keys_of(migrated_database, account) == [first]


def test_a_signed_out_key_can_be_revoked(migrated_database: Engine) -> None:
    account = guest(migrated_database)
    kid = register(migrated_database, account, key(1)).id
    sign_out(migrated_database, session_token(migrated_database, account), kid)
    [signed_out] = keys_of(migrated_database, account)

    revoked = revoke(migrated_database, account, kid)

    assert revoked.signed_out_at == signed_out.signed_out_at
    assert revoked.revoked_at is not None


def test_revoking_another_accounts_key_is_not_found(
    migrated_database: Engine,
) -> None:
    account, other = guest(migrated_database), guest(migrated_database)
    theirs = register(migrated_database, other, key(1))

    for kid in (theirs.id, key(2).public_key.kid):
        with pytest.raises(SigningKeyNotFound):
            revoke(migrated_database, account, kid)

    assert keys_of(migrated_database, other) == [theirs]


def test_adoption_moves_the_guests_keys(migrated_database: Engine) -> None:
    bob = verified(migrated_database, "bob@example.com")
    bobs = register(migrated_database, bob, key(1))
    guest_account = guest(migrated_database)
    guests = [register(migrated_database, guest_account, key(n)) for n in (2, 3)]

    in_transaction(migrated_database, lambda s: adopt_guest(s, guest_account, bob))

    assert {k.id for k in keys_of(migrated_database, bob)} == {
        bobs.id,
        *(k.id for k in guests),
    }
    assert keys_of(migrated_database, guest_account) == []
    assert verifying(migrated_database, guests[0].id) == {
        guests[0].id: VerificationKey(key(2).public_key, bob, None)
    }


def test_a_registration_after_adoption_trims_the_keys_it_brought(
    migrated_database: Engine,
) -> None:
    bob = verified(migrated_database, "bob@example.com")
    bobs = fill_to_the_cap(migrated_database, bob)
    guest_account = guest(migrated_database)
    brought = [
        register(migrated_database, guest_account, key(n)).id for n in (100, 101)
    ]
    in_transaction(migrated_database, lambda s: adopt_guest(s, guest_account, bob))
    assert len(live(keys_of(migrated_database, bob))) == LIVE_KEY_LIMIT + 2

    newest = register(migrated_database, bob, key(102))

    keys = keys_of(migrated_database, bob)
    assert len(live(keys)) == LIVE_KEY_LIMIT
    assert set(live(keys)) == {*bobs[3:], *brought, newest.id}


def test_a_write_as_an_adopted_account_is_refused(migrated_database: Engine) -> None:
    bob = verified(migrated_database, "bob@example.com")
    guest_account = guest(migrated_database)
    kid = register(migrated_database, guest_account, key(1)).id
    in_transaction(migrated_database, lambda s: adopt_guest(s, guest_account, bob))

    with pytest.raises(AccountAdopted):
        register(migrated_database, guest_account, key(2))
    with pytest.raises(AccountAdopted):
        revoke(migrated_database, guest_account, kid)

    assert [k.id for k in keys_of(migrated_database, bob)] == [kid]
