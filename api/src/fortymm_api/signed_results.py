"""The signed result format v1. A match result is a CWT claims set in
deterministic CBOR, which its players sign in a COSE_Sign envelope. The QR
text and the link carry that envelope. api/signed-results/README.md is the
specification, and tests/test_signed_results.py checks this module against
every vector in api/signed-results/vectors.json.

The API only verifies. sign() and append_signature() are the clients'
reference recipe.

Every CBOR item in the format is deterministic: the envelope, the payload
and each signer's protected header. cbor2's canonical=True sorts map keys
length-first (RFC 7049), and every map in this format sorts the same that
way as in RFC 8949's bytewise order.

Python's dict treats True, 1 and 1.0 as one key, and the determinism check
can't see the difference. So every map key and every integer is also
checked by its exact type.
"""

import base64
import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import ClassVar, Final, Literal, NewType
from uuid import UUID

import cbor2

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import BestOf, MatchId
from fortymm_api.signing_keys import (
    SIGNATURE_BYTES,
    KeyId,
    SigningPrivateKey,
    SigningPublicKey,
)

# The payload's key for the result. It is the domain tag, so a signature over
# this payload can't pass as one over another CWT that the same key signs
# (#183's proof of possession). A new version is a new key.
DOMAIN_TAG: Final = "fortymm/match-result/v1"
QR_PREFIX: Final = "FMR1:"
LINK_PREFIX: Final = "https://fortymm.com/r#"

_COSE_SIGN: Final = 98
_ES256: Final = -7
_IAT: Final = 6
_ALG: Final = 1
_KID: Final = 4
_PLAYER: Final = "player"
_MATCH, _BEST_OF, _RATED, _PLAYERS, _GAMES, _ENDING, _RETIRED_BY, _REPLACES = range(
    1, 9
)
_COMPLETED: Final = 0
_RETIRED: Final = 1
_SHA256_BYTES: Final = 32
_UUID_BYTES: Final = 16

# 32 bytes: the SHA-256 of the payload bytes, the result's identity. Two
# envelopes with the same payload bytes are the same result.
ResultHash = NewType("ResultHash", bytes)

# An index into MatchResult.players.
type Side = Literal[0, 1]
# One game's points: players[0]'s, then players[1]'s.
type GamePoints = tuple[int, int]
type RefusalCode = Literal["malformed", "unknown_key", "bad_signature"]


@dataclass(frozen=True)
class Completed:
    kind: ClassVar[Literal["completed"]] = "completed"


@dataclass(frozen=True)
class Retired:
    kind: ClassVar[Literal["retired"]] = "retired"
    by: Side


# On the wire: ending 0, or ending 1 with retired_by.
type Ending = Completed | Retired


@dataclass(frozen=True)
class MatchResult:
    """What a signed result says happened in a match. The format fixes only
    its shape and types. Whether the scores are a legal ending (games to 11,
    win by 2, the majority reached) is #188's rule.
    """

    match: MatchId
    best_of: BestOf
    rated: bool
    # Distinct. Their order fixes the order of each game's points.
    players: tuple[PlayerId, PlayerId]
    # In the order played. At most best_of, and fewer after a retirement,
    # whose last game may be unfinished.
    games: tuple[GamePoints, ...]
    ending: Ending
    # A correction names the hash of the result it replaces.
    replaces: ResultHash | None = None

    def __post_init__(self) -> None:
        if self.players[0] == self.players[1]:
            raise ValueError("the players are the same player")
        if len(self.games) > self.best_of:
            raise ValueError("more games than best_of")
        if any(points < 0 for game in self.games for points in game):
            raise ValueError("negative points")
        if self.replaces is not None and len(self.replaces) != _SHA256_BYTES:
            raise ValueError("replaces isn't 32 bytes")


class SignedResultRefused(Exception):
    """The base of the three ways a signed result is refused. `code` is the
    error class that the vectors name and that a client tells apart.

    The checks run in a fixed order, so every input has exactly one code.
    If the bytes aren't this format, the code is malformed, decided from the
    bytes alone before any key lookup. Then unknown_key if a kid has no key.
    Then bad_signature if a signature fails.
    """

    code: ClassVar[RefusalCode]


class Malformed(SignedResultRefused):
    """The bytes aren't this format. The message says which rule failed, for
    logs. No client matches on it."""

    code = "malformed"


class UnknownKey(SignedResultRefused):
    """A kid that the caller's keys don't include."""

    code = "unknown_key"

    def __init__(self, kids: frozenset[KeyId]) -> None:
        super().__init__(f"{len(kids)} unknown key id(s)")
        self.kids = kids


class BadSignature(SignedResultRefused):
    """A signature that doesn't verify with the key its kid names: the first
    such signature, in envelope order."""

    code = "bad_signature"

    def __init__(self, kid: KeyId) -> None:
        super().__init__(f"the signature by key {kid.hex()} doesn't verify")
        self.kid = kid


@dataclass(frozen=True)
class Approval:
    """One verified signature: the key with this kid approves the result for
    this player. Whether that key's account may approve for that player is
    #188's rule, as is a player that a merge later points at another
    (merged_into). The format accepts the player id as it is.
    """

    kid: KeyId
    player: PlayerId


@dataclass(frozen=True)
class VerifiedResult:
    """A result whose every signature verified."""

    hash: ResultHash
    result: MatchResult
    # The first signer's claim. The server trusts nothing from it (#181).
    issued_at: datetime
    # Never empty. The envelope's order means nothing, and a repeated
    # (kid, player) counts once. One key may approve for both players (one
    # account represents both), and two keys may approve for one player (a
    # player and their representative). Both pass the format.
    approvals: frozenset[Approval]


@dataclass(frozen=True)
class _Signature:
    protected: bytes
    kid: KeyId
    player: PlayerId
    signature: bytes


@dataclass(frozen=True)
class UnverifiedEnvelope:
    """A decoded envelope whose signatures aren't checked yet. It gives the
    result out only through verify(), so no caller can act on an unverified
    result. Its one other use is to name the keys to look up.
    """

    _payload: bytes = field(repr=False)
    _result: MatchResult
    _issued_at: datetime
    _signatures: tuple[_Signature, ...]

    @property
    def kids(self) -> frozenset[KeyId]:
        """The kids of the envelope's signatures. The caller finds their keys
        and passes them to verify()."""
        return frozenset(s.kid for s in self._signatures)

    def verify(self, keys: Iterable[SigningPublicKey]) -> VerifiedResult:
        """Check every signature with the key its kid names, and return the
        result.

        `keys` may include keys that this envelope doesn't use. Each key's
        kid comes from the key itself, so a caller can't pair a kid with the
        wrong key and credit an approval to someone else. A key's state
        (revoked, signed out) is the caller's business, not the format's.

        Raises UnknownKey if any kid has no key, before any signature is
        checked. Then raises BadSignature for the first signature that fails.
        """
        found = {key.kid: key for key in keys}
        if missing := self.kids - found.keys():
            raise UnknownKey(frozenset(missing))
        for s in self._signatures:
            if not found[s.kid].verify(
                s.signature, _sig_structure(s.protected, self._payload)
            ):
                raise BadSignature(s.kid)
        return VerifiedResult(
            hash=ResultHash(hashlib.sha256(self._payload).digest()),
            result=self._result,
            issued_at=self._issued_at,
            approvals=frozenset(Approval(s.kid, s.player) for s in self._signatures),
        )


def encode_payload(result: MatchResult, issued_at: datetime) -> bytes:
    """The payload: {6: iat, DOMAIN_TAG: the result map}, in deterministic
    CBOR. These are the exact bytes every signer signs, and their SHA-256 is
    the result's hash.

    issued_at must be timezone-aware, in whole seconds and not before 1970
    (ValueError otherwise), because iat is an unsigned integer of seconds,
    and decoding a payload must give back what was encoded.
    """
    if issued_at.utcoffset() is None:
        raise ValueError("issued_at has no timezone")
    if issued_at.microsecond:
        raise ValueError("issued_at has a sub-second part")
    iat = int(issued_at.timestamp())
    if iat < 0:
        raise ValueError("issued_at is before 1970")
    claims: dict[int | str, object] = {_IAT: iat, DOMAIN_TAG: _result_map(result)}
    return _dumps(claims)


def sign(
    result: MatchResult,
    issued_at: datetime,
    key: SigningPrivateKey,
    player: PlayerId,
) -> bytes:
    """A new envelope with one signature, in which `key` approves the result
    for `player`. ValueError if player isn't one of result.players.
    """
    payload = encode_payload(result, issued_at)
    side = _side_of(result.players, player)
    return _envelope(payload, [_cose_signature(payload, key, side)])


def append_signature(
    envelope: bytes, key: SigningPrivateKey, player: PlayerId
) -> bytes:
    """What the second signer does: add a COSE_Signature over the envelope's
    own payload bytes. It never re-encodes them. A re-encoded payload would
    be a different result, or would break the first signature.

    Raises Malformed if the envelope isn't this format, and ValueError if
    player isn't in its payload. It doesn't check the existing signatures,
    because a signer has no keys to check them with. Appending the same
    (key, player) twice gives a duplicate, which verify() counts once.
    """
    unverified = decode_envelope(envelope)
    side = _side_of(unverified._result.players, player)
    signatures = [(s.protected, s.signature) for s in unverified._signatures]
    signatures.append(_cose_signature(unverified._payload, key, side))
    return _envelope(unverified._payload, signatures)


def decode_envelope(envelope: bytes) -> UnverifiedEnvelope:
    """Parse envelope bytes. Check everything that needs no key, and raise
    Malformed for anything that isn't this format: a non-deterministic
    envelope, payload or signer header, a tag other than 98, a body header
    that isn't empty, a payload with other claims or another result shape,
    a signer header with other labels, another alg, a side that isn't 0 or
    1, or a signature that isn't 64 bytes.
    """
    item = _loads_deterministic(envelope)
    if not isinstance(item, cbor2.CBORTag) or item.tag != _COSE_SIGN:
        raise Malformed("not a COSE_Sign (tag 98)")
    protected, unprotected, payload, signatures = _array(item.value, 4)
    if protected != b"":
        raise Malformed("the body protected header isn't the empty byte string")
    if not isinstance(unprotected, Mapping) or unprotected:
        raise Malformed("the body unprotected header isn't an empty map")
    if not isinstance(payload, bytes):
        raise Malformed("the payload isn't a byte string")
    result, issued_at = _decode_payload(payload)
    cose_signatures = _array(signatures)
    if not cose_signatures:
        raise Malformed("no signatures")
    return UnverifiedEnvelope(
        payload,
        result,
        issued_at,
        tuple(_decode_signature(s, result.players) for s in cose_signatures),
    )


def qr_text(envelope: bytes) -> str:
    """QR_PREFIX, then the Base45 (RFC 9285) of the envelope bytes, with no
    compression. Every character is in QR's alphanumeric set."""
    return QR_PREFIX + _b45encode(envelope)


def link(envelope: bytes) -> str:
    """LINK_PREFIX, then the unpadded base64url (RFC 4648 section 5) of the
    envelope bytes. The fragment never reaches a server log or a link
    preview."""
    return LINK_PREFIX + _b64url_encode(envelope)


def envelope_from_text(text: str) -> bytes:
    """The envelope bytes from a QR text or a link, told apart by prefix,
    still to be passed to decode_envelope(). Raises Malformed for any other
    prefix, a character outside the encoding's alphabet, or a non-canonical
    encoding.
    """
    if text.startswith(QR_PREFIX):
        return _b45decode(text.removeprefix(QR_PREFIX))
    if text.startswith(LINK_PREFIX):
        return _b64url_decode(text.removeprefix(LINK_PREFIX))
    raise Malformed("neither a QR text nor a link")


def _dumps(value: object) -> bytes:
    return cbor2.dumps(value, canonical=True)


def _loads_deterministic(data: bytes) -> object:
    """Decode one CBOR item, and raise Malformed unless encoding it again
    gives `data` exactly. That refuses trailing bytes (cbor2.loads ignores
    them), non-shortest integers, indefinite lengths, duplicate map keys
    (the dict keeps one), unsorted keys and floats wider than needed. A value
    that re-encodes the same but has the wrong type, such as tag 37 (UUID)
    or a float iat, is left to the type checks.
    """
    try:
        value = cbor2.loads(data)
        again = _dumps(value)
    except (
        cbor2.CBORError,
        ValueError,
        TypeError,
        OverflowError,
        RecursionError,
    ) as error:
        raise Malformed(f"not CBOR: {error}") from error
    if again != data:
        raise Malformed("not deterministic CBOR")
    return value


def _decode_payload(payload: bytes) -> tuple[MatchResult, datetime]:
    claims = _exact_keys(_loads_deterministic(payload), required={_IAT, DOMAIN_TAG})
    try:
        issued_at = datetime.fromtimestamp(_uint(claims[_IAT]), UTC)
    except (OverflowError, OSError, ValueError) as error:
        raise Malformed("iat is out of range") from error
    r = _exact_keys(
        claims[DOMAIN_TAG],
        required={_MATCH, _BEST_OF, _RATED, _PLAYERS, _GAMES, _ENDING},
        optional={_RETIRED_BY, _REPLACES},
    )
    ending: Ending
    match _int(r[_ENDING]):
        case 0 if _RETIRED_BY not in r:
            ending = Completed()
        case 1 if _RETIRED_BY in r:
            ending = Retired(_side(r[_RETIRED_BY]))
        case _:
            raise Malformed("ending isn't 0 without retired_by or 1 with it")
    first, second = _array(r[_PLAYERS], 2)
    try:
        result = MatchResult(
            match=MatchId(_uuid(r[_MATCH])),
            best_of=_best_of(r[_BEST_OF]),
            rated=_bool(r[_RATED]),
            players=(PlayerId(_uuid(first)), PlayerId(_uuid(second))),
            games=tuple(_game(g) for g in _array(r[_GAMES])),
            ending=ending,
            replaces=(
                ResultHash(_bstr(r[_REPLACES], _SHA256_BYTES))
                if _REPLACES in r
                else None
            ),
        )
    except ValueError as error:
        raise Malformed(str(error)) from error
    return result, issued_at


def _decode_signature(item: object, players: tuple[PlayerId, PlayerId]) -> _Signature:
    protected, unprotected, signature = _array(item, 3)
    if not isinstance(protected, bytes):
        raise Malformed("a signer's protected header isn't a byte string")
    if not isinstance(unprotected, Mapping) or unprotected:
        raise Malformed("a signer's unprotected header isn't an empty map")
    if not isinstance(signature, bytes) or len(signature) != SIGNATURE_BYTES:
        raise Malformed("a signature isn't 64 bytes")
    header = _exact_keys(
        _loads_deterministic(protected), required={_ALG, _KID, _PLAYER}
    )
    if _int(header[_ALG]) != _ES256:
        raise Malformed("a signer's alg isn't ES256")
    kid = KeyId(_bstr(header[_KID], _SHA256_BYTES))
    side = _side(header[_PLAYER])
    return _Signature(protected, kid, players[side], signature)


def _exact_keys(
    value: object,
    required: set[int | str],
    optional: set[int | str] | None = None,
) -> Mapping[int | str, object]:
    """A map whose keys are exactly `required` plus any of `optional`, each
    compared by type as well as value: CBOR true or 1.0 never passes for 1,
    and text "1" never passes for 1."""
    if not isinstance(value, Mapping):
        raise Malformed("not a map")
    if any(type(key) not in (int, str) for key in value):
        raise Malformed("a map key isn't an integer or text")
    keys = set(value)
    if not required <= keys <= required | (optional or set()):
        raise Malformed(f"the map's keys are {sorted(map(str, keys))}")
    return value


def _int(value: object) -> int:
    if type(value) is not int:
        raise Malformed("not an integer")
    return value


def _uint(value: object) -> int:
    n = _int(value)
    if n < 0:
        raise Malformed("not an unsigned integer")
    return n


def _bool(value: object) -> bool:
    if type(value) is not bool:
        raise Malformed("not a boolean")
    return value


def _bstr(value: object, length: int) -> bytes:
    if not isinstance(value, bytes) or len(value) != length:
        raise Malformed(f"not a byte string of {length} bytes")
    return value


def _uuid(value: object) -> UUID:
    """A byte string of 16 bytes. A tag 37 UUID is refused, because cbor2
    decodes it to uuid.UUID, which isn't bytes."""
    return UUID(bytes=_bstr(value, _UUID_BYTES))


def _array(value: object, length: int | None = None) -> Sequence[object]:
    """A CBOR array. cbor2 decodes one inside a tag as a tuple, so this
    matches any sequence but the string kinds."""
    if not isinstance(value, Sequence) or isinstance(value, bytes | str):
        raise Malformed("not an array")
    if length is not None and len(value) != length:
        raise Malformed(f"not an array of {length}")
    return value


def _best_of(value: object) -> BestOf:
    match _int(value):
        case 3:
            return 3
        case 5:
            return 5
        case 7:
            return 7
    raise Malformed("best_of isn't 3, 5 or 7")


def _side(value: object) -> Side:
    match _int(value):
        case 0:
            return 0
        case 1:
            return 1
    raise Malformed("a side isn't 0 or 1")


def _game(value: object) -> GamePoints:
    first, second = _array(value, 2)
    return _int(first), _int(second)


def _side_of(players: tuple[PlayerId, PlayerId], player: PlayerId) -> Side:
    if player == players[0]:
        return 0
    if player == players[1]:
        return 1
    raise ValueError(f"player {player} isn't in the match")


def _result_map(result: MatchResult) -> dict[int, object]:
    r: dict[int, object] = {
        _MATCH: result.match.bytes,
        _BEST_OF: result.best_of,
        _RATED: result.rated,
        _PLAYERS: [player.bytes for player in result.players],
        _GAMES: [list(game) for game in result.games],
        _ENDING: _COMPLETED,
    }
    if isinstance(result.ending, Retired):
        r[_ENDING] = _RETIRED
        r[_RETIRED_BY] = result.ending.by
    if result.replaces is not None:
        r[_REPLACES] = result.replaces
    return r


def _sig_structure(signer_protected: bytes, payload: bytes) -> bytes:
    """The bytes a signer signs (RFC 9052 section 4.4): ["Signature", the
    empty body protected header, signer_protected, no external AAD,
    payload], in deterministic CBOR."""
    return _dumps(["Signature", b"", signer_protected, b"", payload])


def _cose_signature(
    payload: bytes, key: SigningPrivateKey, side: Side
) -> tuple[bytes, bytes]:
    protected = _dumps({_ALG: _ES256, _KID: key.public_key.kid, _PLAYER: side})
    return protected, key.sign(_sig_structure(protected, payload))


def _envelope(payload: bytes, signatures: Sequence[tuple[bytes, bytes]]) -> bytes:
    body = [b"", {}, payload, [[p, {}, s] for p, s in signatures]]
    return _dumps(cbor2.CBORTag(_COSE_SIGN, body))


_BASE45: Final = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"


def _b45encode(data: bytes) -> str:
    """RFC 9285: each 2 bytes become 3 characters, low digit first, and a
    final odd byte becomes 2."""
    out = []
    for i in range(0, len(data), 2):
        chunk = data[i : i + 2]
        n = int.from_bytes(chunk, "big")
        for _ in range(len(chunk) + 1):
            n, digit = divmod(n, 45)
            out.append(_BASE45[digit])
    return "".join(out)


def _b45decode(text: str) -> bytes:
    """RFC 9285, strict: Malformed for a character outside the alphabet, a
    length of 1 mod 3, a group of three worth more than 65535, or a group of
    two worth more than 255."""
    if len(text) % 3 == 1:
        raise Malformed("a Base45 text can't be 1 mod 3 characters long")
    if any(c not in _BASE45 for c in text):
        raise Malformed("a character isn't in the Base45 alphabet")
    out = bytearray()
    for i in range(0, len(text), 3):
        group = text[i : i + 3]
        n = sum(_BASE45.index(c) * 45**k for k, c in enumerate(group))
        if n >= 256 ** (len(group) - 1):
            raise Malformed("a Base45 group is worth more than its bytes hold")
        out += n.to_bytes(len(group) - 1, "big")
    return bytes(out)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    """Strict: Malformed unless encoding the result gives `text` again.
    Python's urlsafe_b64decode quietly drops characters outside the alphabet
    and accepts padding and nonzero spare bits."""
    try:
        data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except ValueError as error:
        raise Malformed("not base64url") from error
    if _b64url_encode(data) != text:
        raise Malformed("not canonical unpadded base64url")
    return data
