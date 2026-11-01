"""A device's P-256 signing key, as the server sees it: the public point, its
COSE_Key bytes, its thumbprint (the `kid` every signature cites, RFC 9679)
and ES256 over a raw `r || s` signature.

The API holds no private key. SigningPrivateKey is the clients' reference
recipe. tests/test_signing_keys.py guards this module.

#183's `signing_keys.public_key` column stores to_cose_key(), so
`sha256(public_key) == kid` holds for every row.
"""

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final, NewType, Self

import cbor2
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

# 32 bytes: the SHA-256 of the key's COSE_Key bytes, its RFC 9679 thumbprint.
KeyId = NewType("KeyId", bytes)

COORDINATE_BYTES: Final = 32
SIGNATURE_BYTES: Final = 2 * COORDINATE_BYTES

# COSE_Key labels (RFC 9053 section 7.1.1) and their values for P-256.
_KTY: Final = 1
_CRV: Final = -1
_X: Final = -2
_Y: Final = -3
_EC2: Final = 2
_P256: Final = 1
_P256_ORDER: Final = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


class InvalidKey(ValueError):
    """Key material that isn't a P-256 key in this format's encoding."""


@dataclass(frozen=True)
class SigningPublicKey:
    """A P-256 public point, each coordinate 32 bytes big-endian. Valid by
    construction, so every instance verifies and has a thumbprint."""

    x: bytes
    y: bytes

    def __post_init__(self) -> None:
        if len(self.x) != COORDINATE_BYTES or len(self.y) != COORDINATE_BYTES:
            raise InvalidKey("a coordinate isn't 32 bytes")
        _point(self)

    @classmethod
    def from_cose_key(cls, data: bytes) -> Self:
        """Parse a COSE_Key that is exactly {1: 2, -1: 1, -2: x, -3: y} in
        deterministic CBOR. Any other map, such as one with a kid or alg
        parameter, would have another thumbprint, so it's InvalidKey."""
        try:
            value = cbor2.loads(data)
            again = cbor2.dumps(value, canonical=True)
        except (cbor2.CBORError, ValueError, TypeError, RecursionError) as error:
            raise InvalidKey("not CBOR") from error
        if again != data or not isinstance(value, Mapping):
            raise InvalidKey("not a deterministic COSE_Key map")
        # bool is an int in Python, so a CBOR true key would pass as 1.
        if {type(key) for key in value} != {int} or set(value) != {_KTY, _CRV, _X, _Y}:
            raise InvalidKey("not exactly the kty, crv, x and y parameters")
        kty, crv = value[_KTY], value[_CRV]
        if type(kty) is not int or type(crv) is not int:
            raise InvalidKey("kty or crv isn't an integer")
        if kty != _EC2 or crv != _P256:
            raise InvalidKey("not an EC2 key on P-256")
        x, y = value[_X], value[_Y]
        if not isinstance(x, bytes) or not isinstance(y, bytes):
            raise InvalidKey("a coordinate isn't a byte string")
        return cls(x, y)

    def to_cose_key(self) -> bytes:
        """The deterministic CBOR of {1: 2, -1: 1, -2: x, -3: y}."""
        return cbor2.dumps(
            {_KTY: _EC2, _CRV: _P256, _X: self.x, _Y: self.y}, canonical=True
        )

    @property
    def kid(self) -> KeyId:
        """The RFC 9679 thumbprint, sha256(to_cose_key())."""
        return KeyId(hashlib.sha256(self.to_cose_key()).digest())

    def verify(self, signature: bytes, message: bytes) -> bool:
        """ES256 over `message`, with a raw `r || s` signature of 64 bytes.
        False for a signature of another length or one that doesn't verify.
        Never raises for bad input."""
        if len(signature) != SIGNATURE_BYTES:
            return False
        r = int.from_bytes(signature[:COORDINATE_BYTES], "big")
        s = int.from_bytes(signature[COORDINATE_BYTES:], "big")
        try:
            _point(self).verify(
                encode_dss_signature(r, s), message, ec.ECDSA(hashes.SHA256())
            )
        except InvalidSignature, ValueError:
            return False
        return True


@dataclass(frozen=True)
class SigningPrivateKey:
    """A P-256 private scalar d, 32 bytes big-endian, with 1 <= d < the
    curve's order."""

    d: bytes = field(repr=False)

    def __post_init__(self) -> None:
        if len(self.d) != COORDINATE_BYTES:
            raise InvalidKey("the scalar isn't 32 bytes")
        if not 1 <= int.from_bytes(self.d, "big") < _P256_ORDER:
            raise InvalidKey("the scalar isn't in [1, n - 1]")

    @property
    def public_key(self) -> SigningPublicKey:
        numbers = _private(self).public_key().public_numbers()
        return SigningPublicKey(
            numbers.x.to_bytes(COORDINATE_BYTES, "big"),
            numbers.y.to_bytes(COORDINATE_BYTES, "big"),
        )

    def sign(self, message: bytes) -> bytes:
        """ES256 over `message` as raw `r || s`. Deterministic (RFC 6979)."""
        der = _private(self).sign(
            message, ec.ECDSA(hashes.SHA256(), deterministic_signing=True)
        )
        r, s = decode_dss_signature(der)
        return r.to_bytes(COORDINATE_BYTES, "big") + s.to_bytes(COORDINATE_BYTES, "big")


def _point(key: SigningPublicKey) -> ec.EllipticCurvePublicKey:
    numbers = ec.EllipticCurvePublicNumbers(
        int.from_bytes(key.x, "big"), int.from_bytes(key.y, "big"), ec.SECP256R1()
    )
    try:
        return numbers.public_key()
    except ValueError as error:
        raise InvalidKey("the point isn't on P-256") from error


def _private(key: SigningPrivateKey) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(key.d, "big"), ec.SECP256R1())
