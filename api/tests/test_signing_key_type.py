import hashlib
from uuid import UUID

import cbor2
import pytest
from pycose.algorithms import Es256
from pycose.headers import KID, Algorithm
from signed_result_vectors import pycose_sign1, pycose_verifies_registration

from fortymm_api.accounts import AccountId
from fortymm_api.signing_keys import (
    REGISTRATION_PROOF_BYTES,
    REGISTRATION_TAG,
    InvalidKey,
    SigningPrivateKey,
    SigningPublicKey,
)

KEY = SigningPrivateKey(hashlib.sha256(b"test key").digest())
OTHER_KEY = SigningPrivateKey(hashlib.sha256(b"another test key").digest())
MESSAGE = b"the bytes to sign"

# RFC 9679 section 6, the example thumbprint of RFC 9052's example key.
RFC_9679_X = bytes.fromhex(
    "65eda5a12577c2bae829437fe338701a10aaa375e1bb5b5de108de439c08551d"
)
RFC_9679_Y = bytes.fromhex(
    "1e52ed75701163f7f9e40ddf9f341b3dc9ba860af7e0ca7ca7e9eecd0084d19c"
)
RFC_9679_THUMBPRINT = bytes.fromhex(
    "496bd8afadf307e5b08c64b0421bf9dc01528a344a43bda88fadd1669da253ec"
)

# P-256's field prime and curve constant b (SEC 2 section 2.4.2). The point
# with x = 5 is on the curve, and 5 + p still fits in 32 bytes, so it is a
# second encoding of the same x.
P256_PRIME = 2**256 - 2**224 + 2**192 + 2**96 - 1
P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
X_OF_5 = 5
Y_OF_5 = pow(
    (X_OF_5**3 - 3 * X_OF_5 + P256_B) % P256_PRIME, (P256_PRIME + 1) // 4, P256_PRIME
)


def test_a_signature_verifies_with_the_signers_public_key() -> None:
    signature = KEY.sign(MESSAGE)

    assert len(signature) == 64
    assert KEY.public_key.verify(signature, MESSAGE)


def test_signing_is_deterministic() -> None:
    assert KEY.sign(MESSAGE) == KEY.sign(MESSAGE)


@pytest.mark.parametrize(
    ("signature", "message"),
    [
        (KEY.sign(MESSAGE), b"another message"),
        (OTHER_KEY.sign(MESSAGE), MESSAGE),
        (KEY.sign(MESSAGE)[:63], MESSAGE),
        (KEY.sign(MESSAGE) + b"\0", MESSAGE),
        (bytes(64), MESSAGE),
        (b"\xff" * 64, MESSAGE),
    ],
    ids=[
        "another message",
        "another key",
        "63 bytes",
        "65 bytes",
        "r and s of zero",
        "r and s above the order",
    ],
)
def test_verify_is_false_for_a_signature_that_does_not_fit(
    signature: bytes, message: bytes
) -> None:
    assert KEY.public_key.verify(signature, message) is False


def test_the_kid_matches_the_rfc_9679_example() -> None:
    key = SigningPublicKey(RFC_9679_X, RFC_9679_Y)

    assert key.kid == RFC_9679_THUMBPRINT
    assert hashlib.sha256(key.to_cose_key()).digest() == key.kid


def test_from_cose_key_reads_what_to_cose_key_wrote() -> None:
    key = KEY.public_key

    assert SigningPublicKey.from_cose_key(key.to_cose_key()) == key


def _cose_key(changes: dict[object, object] | None = None) -> bytes:
    parameters: dict[object, object] = {
        1: 2,
        -1: 1,
        -2: KEY.public_key.x,
        -3: KEY.public_key.y,
    }
    parameters.update(changes or {})
    return cbor2.dumps(parameters, canonical=True)


@pytest.mark.parametrize(
    "data",
    [
        _cose_key({2: b"a kid"}),
        _cose_key({-1: 2}),
        _cose_key({1: True}),
        _cose_key({-1: True}),
        _cose_key({1: 2.0}),
        _cose_key({-2: KEY.public_key.x[:31]}),
        _cose_key({-2: KEY.public_key.x.hex()}),
        cbor2.dumps({-3: KEY.public_key.y, -2: KEY.public_key.x, -1: 1, 1: 2}),
        _cose_key() + b"\0",
        cbor2.dumps([1, 2]),
        b"",
    ],
    ids=[
        "extra kid parameter",
        "crv P-384",
        "kty as true",
        "crv as true",
        "kty as a float",
        "x of 31 bytes",
        "x as text",
        "not deterministic",
        "trailing byte",
        "not a map",
        "no bytes",
    ],
)
def test_from_cose_key_refuses_any_other_map(data: bytes) -> None:
    with pytest.raises(InvalidKey):
        SigningPublicKey.from_cose_key(data)


def test_a_public_key_refuses_a_point_off_the_curve() -> None:
    with pytest.raises(InvalidKey):
        SigningPublicKey(KEY.public_key.x, bytes(32))


def test_a_public_key_refuses_a_coordinate_of_another_length() -> None:
    with pytest.raises(InvalidKey):
        SigningPublicKey(KEY.public_key.x[:31], KEY.public_key.y)


def _coordinate(n: int) -> bytes:
    return n.to_bytes(32, "big")


def test_a_public_key_refuses_a_coordinate_written_as_itself_plus_the_prime() -> None:
    SigningPublicKey(_coordinate(X_OF_5), _coordinate(Y_OF_5))

    with pytest.raises(InvalidKey):
        SigningPublicKey(_coordinate(X_OF_5 + P256_PRIME), _coordinate(Y_OF_5))


def test_from_cose_key_refuses_a_coordinate_written_as_itself_plus_the_prime() -> None:
    data = cbor2.dumps(
        {
            1: 2,
            -1: 1,
            -2: _coordinate(X_OF_5 + P256_PRIME),
            -3: _coordinate(Y_OF_5),
        },
        canonical=True,
    )

    with pytest.raises(InvalidKey):
        SigningPublicKey.from_cose_key(data)


@pytest.mark.parametrize(
    "d",
    [
        bytes(32),
        bytes.fromhex(
            "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
        ),
        b"\xff" * 32,
        b"\x01" * 31,
    ],
    ids=["zero", "the curve's order", "above the order", "31 bytes"],
)
def test_a_private_key_refuses_a_scalar_outside_the_curve(d: bytes) -> None:
    with pytest.raises(InvalidKey):
        SigningPrivateKey(d)


def test_a_private_key_keeps_its_scalar_out_of_repr() -> None:
    assert KEY.d.hex() not in repr(KEY)


ACCOUNT = AccountId(UUID(int=0xA))
OTHER_ACCOUNT = AccountId(UUID(int=0xB))


def test_a_registration_proof_verifies_for_its_key_and_account() -> None:
    proof = KEY.registration_proof(ACCOUNT)

    assert KEY.public_key.verify_registration(proof, ACCOUNT) is True


def test_a_registration_proof_for_another_account_is_refused() -> None:
    proof = KEY.registration_proof(OTHER_ACCOUNT)

    assert KEY.public_key.verify_registration(proof, ACCOUNT) is False


def test_a_registration_proof_by_another_key_is_refused() -> None:
    proof = OTHER_KEY.registration_proof(ACCOUNT)

    assert KEY.public_key.verify_registration(proof, ACCOUNT) is False


@pytest.mark.parametrize("key", [KEY, OTHER_KEY], ids=["key", "other key"])
@pytest.mark.parametrize(
    "account",
    [ACCOUNT, OTHER_ACCOUNT, AccountId(UUID(int=2**128 - 1))],
    ids=["account", "other account", "all ones"],
)
def test_every_registration_proof_is_160_bytes(
    key: SigningPrivateKey, account: AccountId
) -> None:
    assert len(key.registration_proof(account)) == REGISTRATION_PROOF_BYTES == 160


def test_a_registration_proof_with_any_bit_flipped_is_refused() -> None:
    proof = KEY.registration_proof(ACCOUNT)

    for bit in range(len(proof) * 8):
        flipped = bytearray(proof)
        flipped[bit // 8] ^= 1 << (bit % 8)
        assert KEY.public_key.verify_registration(bytes(flipped), ACCOUNT) is False, (
            f"bit {bit}"
        )


@pytest.mark.parametrize(
    "proof",
    [
        b"",
        b"\x00",
        KEY.registration_proof(ACCOUNT)[:-1],
        KEY.registration_proof(ACCOUNT) + b"\x00",
        *(hashlib.shake_256(bytes([n])).digest(n) for n in range(1, 200, 7)),
        b"\xff" * REGISTRATION_PROOF_BYTES,
    ],
    ids=lambda proof: f"{len(proof)} bytes",
)
def test_garbage_is_refused_without_raising(proof: bytes) -> None:
    assert KEY.public_key.verify_registration(proof, ACCOUNT) is False


def test_a_registration_proof_is_a_cose_sign1_that_pycose_verifies() -> None:
    proof = KEY.registration_proof(ACCOUNT)

    message = pycose_sign1(proof)

    assert message.phdr == {Algorithm: Es256, KID: KEY.public_key.kid}
    assert message.uhdr == {}
    assert message.payload is not None
    assert cbor2.loads(message.payload) == {REGISTRATION_TAG: {1: ACCOUNT.bytes}}
    assert pycose_verifies_registration(proof, KEY.public_key)
    assert pycose_verifies_registration(proof, OTHER_KEY.public_key) is False
