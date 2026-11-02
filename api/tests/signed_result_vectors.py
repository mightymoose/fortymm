"""Write api/signed-results/vectors.json, the signed result and key
registration test vectors that every client's tests check:
`./bin/mise run api:signed-result-vectors`. Changing an existing vector's
bytes is a format change, which breaks every client.
"""

import base64
import hashlib
import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict, cast
from uuid import NAMESPACE_URL, UUID, uuid5

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from pycose.algorithms import Es256
from pycose.headers import KID, Algorithm
from pycose.keys.ec2 import EC2Key
from pycose.messages.sign1message import Sign1Message
from pycose.messages.signer import CoseSignature
from pycose.messages.signmessage import SignMessage

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.signed_results import (
    DOMAIN_TAG,
    LINK_PREFIX,
    QR_PREFIX,
    Completed,
    MatchResult,
    RefusalCode,
    ResultHash,
    Retired,
    Side,
    append_signature,
    encode_payload,
    link,
    qr_text,
    sign,
)
from fortymm_api.signing_keys import (
    REGISTRATION_PROOF_BYTES,
    SigningPrivateKey,
    SigningPublicKey,
)

VECTORS_PATH = Path(__file__).resolve().parents[1] / "signed-results" / "vectors.json"
GENERATED_BY = (
    "api/tests/signed_result_vectors.py (./bin/mise run api:signed-result-vectors)"
)


class KeyJson(TypedDict):
    d: str  # hex, 32 bytes
    x: str
    y: str
    cose_key: str  # hex of the deterministic COSE_Key
    kid: str  # hex, sha256(cose_key)


class ResultJson(TypedDict):
    match: str  # UUID, lowercase with hyphens
    best_of: Literal[3, 5, 7]
    rated: bool
    players: list[str]
    games: list[list[int]]
    ending: Literal["completed", "retired"]
    retired_by: Side | None  # exactly when ending is "retired"
    replaces: str | None  # hex, 32 bytes


class SignatureJson(TypedDict):
    key: str  # a name in VectorsJson.keys
    kid: str
    side: Side
    player: str  # the UUID of result.players[side]
    protected: str  # hex of the signer's protected header
    to_be_signed: str  # hex of the Sig_structure
    signature: str  # hex, 64 bytes r || s


class ApprovalJson(TypedDict):
    kid: str
    player: str


class ValidJson(TypedDict):
    name: str
    description: str
    note: NotRequired[str]
    issued_at: int
    result: ResultJson
    payload: str
    hash: str
    signatures: list[SignatureJson]  # in envelope order
    approvals: list[ApprovalJson]  # the set verify() returns, sorted by (player, kid)
    envelope: str
    qr: str
    link: str


class InvalidJson(TypedDict):
    name: str
    description: str
    error: RefusalCode
    envelope: NotRequired[str]  # exactly one of envelope (hex) and text
    text: NotRequired[str]  # a QR text or a link


class RegistrationJson(TypedDict):
    name: str
    description: str
    key: str  # a name in VectorsJson.keys
    account: str  # UUID, lowercase with hyphens
    protected: str  # hex of {1: -7, 4: kid}
    payload: str  # hex of {REGISTRATION_TAG: {1: account}}
    to_be_signed: str  # hex of ["Signature1", protected, h'', payload]
    signature: str  # hex, 64 bytes r || s
    proof: str  # hex, REGISTRATION_PROOF_BYTES


class VectorsJson(TypedDict):
    format: str  # DOMAIN_TAG
    generated_by: str
    keys: dict[str, KeyJson]  # the key directory every vector verifies against
    valid: list[ValidJson]
    invalid: list[InvalidJson]
    registrations: list[RegistrationJson]


def _test_key(name: str) -> SigningPrivateKey:
    return SigningPrivateKey(
        hashlib.sha256(f"{DOMAIN_TAG} test key {name}".encode()).digest()
    )


KEYS: dict[str, SigningPrivateKey] = {
    name: _test_key(name) for name in ("ann", "bo", "cy")
}
UNLISTED = _test_key("unlisted")

_NS = uuid5(NAMESPACE_URL, "https://fortymm.com/signed-results/v1/vectors")
ANN = PlayerId(uuid5(_NS, "player ann"))
BO = PlayerId(uuid5(_NS, "player bo"))
MERGED = PlayerId(uuid5(_NS, "player merged later"))
ACCOUNT_A = AccountId(uuid5(_NS, "account a"))
ACCOUNT_B = AccountId(uuid5(_NS, "account b"))
ISSUED_AT = datetime(2026, 11, 1, 12, tzinfo=UTC)


def _match(name: str) -> MatchId:
    return MatchId(uuid5(_NS, f"match {name}"))


def _hash_of(result: MatchResult) -> ResultHash:
    return ResultHash(hashlib.sha256(encode_payload(result, ISSUED_AT)).digest())


BEST_OF_3 = MatchResult(
    match=_match("best-of-3"),
    best_of=3,
    rated=True,
    players=(ANN, BO),
    games=((11, 7), (9, 11), (11, 4)),
    ending=Completed(),
)
RETIRED_MID_MATCH = MatchResult(
    match=_match("retired-mid-match"),
    best_of=5,
    rated=True,
    players=(ANN, BO),
    games=((11, 8), (7, 5)),
    ending=Retired(by=1),
)
RETIRED_BEFORE_ANY_GAME = MatchResult(
    match=_match("retired-before-any-game"),
    best_of=3,
    rated=True,
    players=(ANN, BO),
    games=(),
    ending=Retired(by=0),
)
CORRECTION = MatchResult(
    match=BEST_OF_3.match,
    best_of=3,
    rated=True,
    players=(ANN, BO),
    games=((11, 7), (9, 11), (11, 5)),
    ending=Completed(),
    replaces=_hash_of(BEST_OF_3),
)
UNRATED = MatchResult(
    match=_match("unrated"),
    best_of=3,
    rated=False,
    players=(ANN, BO),
    games=((11, 9), (11, 6)),
    ending=Completed(),
)
LONGEST_FIRST = MatchResult(
    match=_match("longest"),
    best_of=7,
    rated=True,
    players=(ANN, BO),
    games=((26, 24), (24, 26), (27, 25), (25, 27), (30, 28), (28, 30), (26, 24)),
    ending=Completed(),
)
# Every score takes two CBOR bytes, every game is played, and the correction
# and the retirement add their keys.
LONGEST = MatchResult(
    match=_match("longest"),
    best_of=7,
    rated=True,
    players=(ANN, BO),
    games=((26, 24), (24, 26), (27, 25), (25, 27), (30, 28), (28, 30), (25, 24)),
    ending=Retired(by=1),
    replaces=_hash_of(LONGEST_FIRST),
)
BEST_OF_5 = MatchResult(
    match=_match("best-of-5"),
    best_of=5,
    rated=True,
    players=(ANN, BO),
    games=((11, 5), (11, 6), (11, 7)),
    ending=Completed(),
)
MERGED_PLAYER = MatchResult(
    match=_match("merged-player"),
    best_of=3,
    rated=True,
    players=(MERGED, BO),
    games=((11, 7), (11, 9)),
    ending=Completed(),
)


@dataclass(frozen=True)
class ValidCase:
    name: str
    description: str
    result: MatchResult
    signers: tuple[tuple[str, PlayerId], ...]
    note: str | None = None
    last_signed_by: Literal["api", "pycose"] = "api"


VALID: tuple[ValidCase, ...] = (
    ValidCase(
        "completed-best-of-3",
        "A completed best-of-3 rated match, approved by both players.",
        BEST_OF_3,
        (("ann", ANN), ("bo", BO)),
    ),
    ValidCase(
        "completed-best-of-3-signatures-swapped",
        "The same payload with the signatures in the other order. Same hash,"
        " same approvals.",
        BEST_OF_3,
        (("bo", BO), ("ann", ANN)),
    ),
    ValidCase(
        "half-signed",
        "One signature. This is what passes between phones.",
        BEST_OF_3,
        (("ann", ANN),),
    ),
    ValidCase(
        "retired-mid-match",
        "Best of 5, retired by player 1 with fewer games than best_of, the last"
        " one unfinished.",
        RETIRED_MID_MATCH,
        (("ann", ANN), ("bo", BO)),
    ),
    ValidCase(
        "retired-before-any-game",
        "Retired by player 0 before any game ended. games is empty.",
        RETIRED_BEFORE_ANY_GAME,
        (("ann", ANN), ("bo", BO)),
    ),
    ValidCase(
        "correction",
        "A correction of completed-best-of-3. replaces is that result's hash.",
        CORRECTION,
        (("ann", ANN), ("bo", BO)),
    ),
    ValidCase(
        "unrated",
        "An unrated match with one signature.",
        UNRATED,
        (("bo", BO),),
    ),
    ValidCase(
        "longest",
        "Best of 7, every game past deuce, retired in the last game, a"
        " correction, two signatures. The QR budget is measured on it.",
        LONGEST,
        (("ann", ANN), ("bo", BO)),
    ),
    ValidCase(
        "second-signature-by-pycose",
        "The first signature by the API's codec, the second appended by pycose"
        " over the received payload bytes.",
        BEST_OF_5,
        (("ann", ANN), ("bo", BO)),
        last_signed_by="pycose",
    ),
    ValidCase(
        "merged-player",
        "Names a player that a merge later points at another player.",
        MERGED_PLAYER,
        (("ann", MERGED), ("bo", BO)),
        note="Valid at the format level. Don't refuse it: the server resolves the"
        " player through merged_into.",
    ),
    ValidCase(
        "one-key-for-both-players",
        "One key approves for both players, as one account that represents both does.",
        BEST_OF_3,
        (("cy", ANN), ("cy", BO)),
    ),
    ValidCase(
        "two-keys-for-one-player",
        "Two keys approve for player 0: the player's own and a representative's.",
        BEST_OF_3,
        (("ann", ANN), ("cy", ANN), ("bo", BO)),
    ),
    ValidCase(
        "same-signature-twice",
        "The same COSE_Signature twice. approvals has one entry.",
        BEST_OF_3,
        (("ann", ANN), ("ann", ANN)),
    ),
)


@dataclass(frozen=True)
class InvalidCase:
    name: str
    description: str
    error: RefusalCode
    make: Callable[[dict[str, bytes]], bytes | str]


# The elements of a COSE_Sign array and of each COSE_Signature in it.
BODY_PROTECTED, BODY_UNPROTECTED, PAYLOAD, SIGNATURES = range(4)
PROTECTED, UNPROTECTED, SIGNATURE = range(3)


def _thaw(value: Any) -> Any:
    """cbor2 decodes a tag's contents as tuples and frozendicts. Plain lists
    and dicts can be changed, and pycose accepts only those."""
    if isinstance(value, cbor2.CBORTag):
        return cbor2.CBORTag(value.tag, _thaw(value.value))
    if isinstance(value, tuple | list):
        return [_thaw(v) for v in value]
    if isinstance(value, Mapping):
        return {k: _thaw(v) for k, v in value.items()}
    return value


def _parts(envelope: bytes) -> list[Any]:
    tagged = cbor2.loads(envelope)
    assert tagged.tag == 98
    parts: list[Any] = _thaw(tagged.value)
    return parts


def _assemble(parts: list[Any], tag: int = 98) -> bytes:
    return cbor2.dumps(cbor2.CBORTag(tag, parts), canonical=True)


def _payload_of(parts: list[Any]) -> dict[Any, Any]:
    claims: dict[Any, Any] = _thaw(cbor2.loads(parts[PAYLOAD]))
    return claims


def replace_payload(
    envelope: bytes, change: Callable[[dict[Any, Any]], None], *, canonical: bool = True
) -> bytes:
    parts = _parts(envelope)
    claims = _payload_of(parts)
    change(claims)
    parts[PAYLOAD] = cbor2.dumps(claims, canonical=canonical)
    return _assemble(parts)


def replace_body(envelope: bytes, change: Callable[[list[Any]], None]) -> bytes:
    parts = _parts(envelope)
    change(parts)
    return _assemble(parts)


def replace_signer_header(
    envelope: bytes, index: int, change: Callable[[dict[Any, Any]], None]
) -> bytes:
    parts = _parts(envelope)
    header: dict[Any, Any] = _thaw(cbor2.loads(parts[SIGNATURES][index][PROTECTED]))
    change(header)
    parts[SIGNATURES][index][PROTECTED] = cbor2.dumps(header, canonical=True)
    return _assemble(parts)


def _sig_structure_by_cbor2(protected: bytes, payload: bytes) -> bytes:
    # Built here, not imported from the codec, so the vectors cross-check it.
    return cbor2.dumps(["Signature", b"", protected, b"", payload], canonical=True)


def _cose_signature(payload: bytes, name: str, side: Side) -> list[Any]:
    key = KEYS[name]
    protected = cbor2.dumps(
        {1: -7, 4: key.public_key.kid, "player": side}, canonical=True
    )
    return [protected, {}, key.sign(_sig_structure_by_cbor2(protected, payload))]


def _reencoded_by_the_second_signer(envelopes: dict[str, bytes]) -> bytes:
    parts = _parts(envelopes["half-signed"])
    claims = _payload_of(parts)
    claims[DOMAIN_TAG] = dict(reversed(list(claims[DOMAIN_TAG].items())))
    parts[PAYLOAD] = cbor2.dumps(claims, canonical=False)
    parts[SIGNATURES].append(_cose_signature(parts[PAYLOAD], "bo", 1))
    return _assemble(parts)


def _best_of_not_shortest(envelopes: dict[str, bytes]) -> bytes:
    """best_of 3 as the two bytes 0x18 0x03. cbor2 only writes the shortest
    form, so this is byte surgery on the pair (2: 3, 3: true)."""
    parts = _parts(envelopes["completed-best-of-3"])
    payload: bytes = parts[PAYLOAD]
    assert payload.count(b"\x02\x03\x03\xf5") == 1
    parts[PAYLOAD] = payload.replace(b"\x02\x03\x03\xf5", b"\x02\x18\x03\x03\xf5")
    return _assemble(parts)


def _indefinite_signature_array(envelopes: dict[str, bytes]) -> bytes:
    parts = _parts(envelopes["completed-best-of-3"])
    signatures = cbor2.dumps(parts[SIGNATURES], canonical=True)
    assert signatures[0] == 0x82
    parts[SIGNATURES] = []
    return _assemble(parts)[:-1] + b"\x9f" + signatures[1:] + b"\xff"


def _duplicate_result_key(envelopes: dict[str, bytes]) -> bytes:
    """The result map with best_of twice. cbor2 can't write a duplicate key,
    so this is byte surgery: one more pair, and the map's count byte 0xa6
    becomes 0xa7."""
    parts = _parts(envelopes["completed-best-of-3"])
    payload: bytes = parts[PAYLOAD]
    assert payload.count(b"\xa6\x01\x50") == 1
    assert payload.count(b"\x02\x03\x03\xf5") == 1
    payload = payload.replace(b"\xa6\x01\x50", b"\xa7\x01\x50")
    parts[PAYLOAD] = payload.replace(b"\x02\x03\x03\xf5", b"\x02\x03\x02\x03\x03\xf5")
    return _assemble(parts)


def _unknown_kid(envelopes: dict[str, bytes]) -> bytes:
    return append_signature(envelopes["half-signed"], UNLISTED, BO)


def _later_iat(claims: dict[Any, Any]) -> None:
    claims[6] += 1


def _tampered_payload(envelopes: dict[str, bytes]) -> bytes:
    return replace_payload(envelopes["completed-best-of-3"], _later_iat)


def _unknown_kid_and_tampered_payload(envelopes: dict[str, bytes]) -> bytes:
    return replace_payload(_unknown_kid(envelopes), _later_iat)


def _unknown_kid_then_short_signature(envelopes: dict[str, bytes]) -> bytes:
    def change(parts: list[Any]) -> None:
        known, unknown = parts[SIGNATURES]
        known[SIGNATURE] = known[SIGNATURE][:63]
        parts[SIGNATURES] = [unknown, known]

    return replace_body(_unknown_kid(envelopes), change)


def _bad_signature_then_short_signature(envelopes: dict[str, bytes]) -> bytes:
    def change(parts: list[Any]) -> None:
        first, second = parts[SIGNATURES]
        first[SIGNATURE] = first[SIGNATURE][:-1] + bytes([first[SIGNATURE][-1] ^ 1])
        second[SIGNATURE] = second[SIGNATURE][:63]

    return replace_body(envelopes["completed-best-of-3"], change)


def _result_change(
    name: str, change: Callable[[dict[Any, Any]], None]
) -> Callable[[dict[str, bytes]], bytes]:
    def make(envelopes: dict[str, bytes]) -> bytes:
        return replace_payload(
            envelopes[name], lambda claims: change(claims[DOMAIN_TAG])
        )

    return make


def _claims_change(
    name: str, change: Callable[[dict[Any, Any]], None]
) -> Callable[[dict[str, bytes]], bytes]:
    def make(envelopes: dict[str, bytes]) -> bytes:
        return replace_payload(envelopes[name], change)

    return make


def _body_change(
    name: str, change: Callable[[list[Any]], None]
) -> Callable[[dict[str, bytes]], bytes]:
    def make(envelopes: dict[str, bytes]) -> bytes:
        return replace_body(envelopes[name], change)

    return make


def _header_change(
    name: str, index: int, change: Callable[[dict[Any, Any]], None]
) -> Callable[[dict[str, bytes]], bytes]:
    def make(envelopes: dict[str, bytes]) -> bytes:
        return replace_signer_header(envelopes[name], index, change)

    return make


def _set(key: Any, value: Any) -> Callable[[dict[Any, Any]], None]:
    def change(mapping: dict[Any, Any]) -> None:
        mapping[key] = value

    return change


def _delete(key: Any) -> Callable[[dict[Any, Any]], None]:
    def change(mapping: dict[Any, Any]) -> None:
        del mapping[key]

    return change


def _rekey(old: Any, new: Any) -> Callable[[dict[Any, Any]], None]:
    def change(mapping: dict[Any, Any]) -> None:
        mapping[new] = mapping.pop(old)

    return change


def _set_body(index: int, value: Any) -> Callable[[list[Any]], None]:
    def change(parts: list[Any]) -> None:
        parts[index] = value

    return change


def _set_signature(
    index: int, change: Callable[[list[Any]], None]
) -> Callable[[list[Any]], None]:
    def change_body(parts: list[Any]) -> None:
        change(parts[SIGNATURES][index])

    return change_body


def _wrong_qr_prefix(envelopes: dict[str, bytes]) -> str:
    return "FMR2:" + qr_text(envelopes["completed-best-of-3"]).removeprefix(QR_PREFIX)


def _standard_base64_link(envelopes: dict[str, bytes]) -> str:
    envelope = envelopes["half-signed"]
    text = LINK_PREFIX + base64.b64encode(envelope).decode("ascii")
    assert text.endswith("=") and text != link(envelope)
    return text


INVALID: tuple[InvalidCase, ...] = (
    InvalidCase(
        "tampered-payload",
        "iat is one second later, re-encoded deterministically, with both"
        " signatures kept. Neither verifies.",
        "bad_signature",
        _tampered_payload,
    ),
    InvalidCase(
        "unknown-kid",
        "The second signature is by a key the directory doesn't hold.",
        "unknown_key",
        _unknown_kid,
    ),
    InvalidCase(
        "payload-reencoded-in-another-map-order",
        "The second signer re-encoded the payload with the result map's keys in"
        " reverse order and signed that.",
        "malformed",
        _reencoded_by_the_second_signer,
    ),
    InvalidCase(
        "payload-integer-not-shortest",
        "best_of as the two bytes 0x18 0x03.",
        "malformed",
        _best_of_not_shortest,
    ),
    InvalidCase(
        "unknown-result-key",
        "The result map has a key 9.",
        "malformed",
        _result_change("completed-best-of-3", _set(9, 0)),
    ),
    InvalidCase(
        "result-key-as-text",
        'Text "1" in place of the integer key 1. A JavaScript decoder that'
        " builds plain objects accepts it.",
        "malformed",
        _result_change("completed-best-of-3", _rekey(1, "1")),
    ),
    InvalidCase(
        "equal-player-ids",
        "Both players are the same player.",
        "malformed",
        _result_change("completed-best-of-3", _set(4, [ANN.bytes, ANN.bytes])),
    ),
    InvalidCase(
        "retired-by-without-retirement",
        "ending 0 with retired_by present.",
        "malformed",
        _result_change("completed-best-of-3", _set(7, 0)),
    ),
    InvalidCase(
        "retirement-without-retired-by",
        "ending 1 without retired_by.",
        "malformed",
        _result_change("retired-mid-match", _delete(7)),
    ),
    InvalidCase(
        "match-id-as-uuid-tag",
        "The match id as tag 37 around its 16 bytes.",
        "malformed",
        _result_change("completed-best-of-3", _set(1, BEST_OF_3.match)),
    ),
    InvalidCase(
        "rated-as-integer",
        "rated as the integer 1 instead of true.",
        "malformed",
        _result_change("completed-best-of-3", _set(3, 1)),
    ),
    InvalidCase(
        "issued-at-as-float",
        "iat as a float64, as Date.now() / 1000 makes it.",
        "malformed",
        _claims_change("completed-best-of-3", _set(6, 1793534400.0)),
    ),
    InvalidCase(
        "tag-18",
        "COSE_Sign1's tag in place of 98.",
        "malformed",
        lambda envelopes: _assemble(_parts(envelopes["completed-best-of-3"]), 18),
    ),
    InvalidCase(
        "body-protected-header-as-empty-map",
        "h'a0', an encoded empty map, as the body protected header. Some COSE"
        " libraries write this.",
        "malformed",
        _body_change("completed-best-of-3", _set_body(BODY_PROTECTED, b"\xa0")),
    ),
    InvalidCase(
        "envelope-not-deterministic",
        "The signature array has an indefinite length.",
        "malformed",
        _indefinite_signature_array,
    ),
    InvalidCase(
        "no-signatures",
        "An empty signature array.",
        "malformed",
        _body_change("completed-best-of-3", _set_body(SIGNATURES, [])),
    ),
    InvalidCase(
        "signer-unprotected-header-not-empty",
        "The second signer's kid is copied into its unprotected header.",
        "malformed",
        _body_change(
            "completed-best-of-3",
            _set_signature(1, _set_body(UNPROTECTED, {4: KEYS["bo"].public_key.kid})),
        ),
    ),
    InvalidCase(
        "signer-alg-es384",
        "The second signer's alg is -35 (ES384).",
        "malformed",
        _header_change("completed-best-of-3", 1, _set(1, -35)),
    ),
    InvalidCase(
        "signer-alg-label-true",
        "The second signer's alg label is CBOR true, not the integer 1. A"
        " decoder whose maps treat true as 1 (Python's dict does) accepts it."
        ' A true key can\'t sort the same way as the text key "player" under'
        " both length-first and bytewise order, so a decoder that checks"
        " bytewise order refuses it for that. Both faults are malformed.",
        "malformed",
        _header_change("completed-best-of-3", 1, _rekey(1, True)),
    ),
    InvalidCase(
        "signer-side-2",
        "The second signer's player is 2. Only sides 0 and 1 exist.",
        "malformed",
        _header_change("completed-best-of-3", 1, _set("player", 2)),
    ),
    InvalidCase(
        "signer-side-as-bool",
        "The second signer's player is CBOR true, not the integer 1.",
        "malformed",
        _header_change("completed-best-of-3", 1, _set("player", True)),
    ),
    InvalidCase(
        "signer-missing-player",
        "The second signer's header has no player.",
        "malformed",
        _header_change("completed-best-of-3", 1, _delete("player")),
    ),
    InvalidCase(
        "signature-63-bytes",
        "The first signature is one byte short.",
        "malformed",
        _body_change(
            "completed-best-of-3",
            lambda parts: parts[SIGNATURES][0].__setitem__(
                SIGNATURE, parts[SIGNATURES][0][SIGNATURE][:63]
            ),
        ),
    ),
    InvalidCase(
        "qr-wrong-prefix",
        "FMR2: before a valid Base45 text.",
        "malformed",
        _wrong_qr_prefix,
    ),
    InvalidCase(
        "qr-invalid-base45",
        "A Base45 group of three worth more than 65535 (RFC 9285 section 4.2).",
        "malformed",
        lambda envelopes: "FMR1:GGW",
    ),
    InvalidCase(
        "link-standard-base64-padded",
        "The link's envelope in standard base64, with its padding.",
        "malformed",
        _standard_base64_link,
    ),
    InvalidCase(
        "envelope-trailing-byte",
        "A zero byte after the envelope.",
        "malformed",
        lambda envelopes: envelopes["completed-best-of-3"] + b"\x00",
    ),
    InvalidCase(
        "more-games-than-best-of",
        "Four games in a best of 3.",
        "malformed",
        _result_change(
            "completed-best-of-3", _set(5, [[11, 7], [9, 11], [11, 4], [11, 2]])
        ),
    ),
    InvalidCase(
        "missing-result-key",
        "No rated (key 3) in the result map.",
        "malformed",
        _result_change("completed-best-of-3", _delete(3)),
    ),
    InvalidCase(
        "duplicate-result-key",
        "best_of (key 2) twice in the result map.",
        "malformed",
        _duplicate_result_key,
    ),
    InvalidCase(
        "unknown-kid-and-tampered-payload",
        "The unknown-kid envelope with iat one second later and both signatures"
        " kept. The first signature fails and the second kid is unknown, so"
        " unknown_key wins.",
        "unknown_key",
        _unknown_kid_and_tampered_payload,
    ),
    InvalidCase(
        "unknown-kid-then-short-signature",
        "The first signature is by a key the directory doesn't hold, and the"
        " second is 63 bytes. malformed wins.",
        "malformed",
        _unknown_kid_then_short_signature,
    ),
    InvalidCase(
        "bad-signature-then-short-signature",
        "The first signature has one bit of s flipped, so it is well formed and"
        " fails to verify, and the second is 63 bytes. malformed wins.",
        "malformed",
        _bad_signature_then_short_signature,
    ),
    InvalidCase(
        "points-as-bignum",
        "The first game's first points as 2^64, which only a bignum (tag 2) can hold.",
        "malformed",
        _result_change("completed-best-of-3", _set(5, [[2**64, 7], [9, 11], [11, 4]])),
    ),
    InvalidCase(
        "issued-at-after-9999",
        "iat 253402300800, one second after 9999-12-31T23:59:59Z.",
        "malformed",
        _claims_change("completed-best-of-3", _set(6, 253402300800)),
    ),
)


@dataclass(frozen=True)
class RegistrationCase:
    name: str
    description: str
    key: str
    account: AccountId


REGISTRATIONS: tuple[RegistrationCase, ...] = (
    RegistrationCase(
        "ann-for-account-a",
        "ann's key registers to account a.",
        "ann",
        ACCOUNT_A,
    ),
    RegistrationCase(
        "cy-for-account-a",
        "cy's key registers to the same account. An account holds many keys.",
        "cy",
        ACCOUNT_A,
    ),
    RegistrationCase(
        "ann-for-account-b",
        "ann's key registers to account b. The same key's proof differs by"
        " account, and the server refuses it for account a.",
        "ann",
        ACCOUNT_B,
    ),
)


def build() -> VectorsJson:
    valid = [_valid_vector(case) for case in VALID]
    envelopes = {v["name"]: bytes.fromhex(v["envelope"]) for v in valid}
    return VectorsJson(
        format=DOMAIN_TAG,
        generated_by=GENERATED_BY,
        keys={name: _key_json(key) for name, key in KEYS.items()},
        valid=valid,
        invalid=[_invalid_vector(case, envelopes) for case in INVALID],
        registrations=[_registration_vector(case) for case in REGISTRATIONS],
    )


def render(vectors: VectorsJson) -> str:
    return json.dumps(vectors, indent=2) + "\n"


def main() -> None:
    VECTORS_PATH.write_text(render(build()))


def _key_json(key: SigningPrivateKey) -> KeyJson:
    public = key.public_key
    return KeyJson(
        d=key.d.hex(),
        x=public.x.hex(),
        y=public.y.hex(),
        cose_key=public.to_cose_key().hex(),
        kid=public.kid.hex(),
    )


def _valid_vector(case: ValidCase) -> ValidJson:
    payload = encode_payload(case.result, ISSUED_AT)
    envelope = b""
    for i, (name, player) in enumerate(case.signers):
        if i == 0:
            envelope = sign(case.result, ISSUED_AT, KEYS[name], player)
        elif i == len(case.signers) - 1 and case.last_signed_by == "pycose":
            envelope = pycose_append(envelope, KEYS[name], player)
        else:
            envelope = append_signature(envelope, KEYS[name], player)
    parts = _parts(envelope)
    assert parts[PAYLOAD] == payload
    signatures = [
        _signature_json(name, player, case.result, payload, cose_signature)
        for (name, player), cose_signature in zip(
            case.signers, parts[SIGNATURES], strict=True
        )
    ]
    approvals = sorted({(s["player"], s["kid"]) for s in signatures})
    fields: dict[str, Any] = {"name": case.name, "description": case.description}
    if case.note is not None:
        fields["note"] = case.note
    fields.update(
        issued_at=int(ISSUED_AT.timestamp()),
        result=result_json(case.result),
        payload=payload.hex(),
        hash=hashlib.sha256(payload).hexdigest(),
        signatures=signatures,
        approvals=[ApprovalJson(kid=kid, player=player) for player, kid in approvals],
        envelope=envelope.hex(),
        qr=qr_text(envelope),
        link=link(envelope),
    )
    return cast(ValidJson, fields)


def _signature_json(
    name: str,
    player: PlayerId,
    result: MatchResult,
    payload: bytes,
    cose_signature: list[Any],
) -> SignatureJson:
    protected, unprotected, signature = cose_signature
    assert unprotected == {}
    to_be_signed = _sig_structure_by_cbor2(protected, payload)
    public = KEYS[name].public_key
    _check_with_cryptography(public, signature, to_be_signed)
    side: Side = 0 if player == result.players[0] else 1
    assert result.players[side] == player
    return SignatureJson(
        key=name,
        kid=public.kid.hex(),
        side=side,
        player=str(player),
        protected=protected.hex(),
        to_be_signed=to_be_signed.hex(),
        signature=signature.hex(),
    )


def _check_with_cryptography(
    key: SigningPublicKey, signature: bytes, message: bytes
) -> None:
    point = ec.EllipticCurvePublicNumbers(
        int.from_bytes(key.x, "big"), int.from_bytes(key.y, "big"), ec.SECP256R1()
    ).public_key()
    r, s = int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
    point.verify(encode_dss_signature(r, s), message, ec.ECDSA(hashes.SHA256()))


def _invalid_vector(case: InvalidCase, envelopes: dict[str, bytes]) -> InvalidJson:
    made = case.make(envelopes)
    if isinstance(made, bytes):
        return InvalidJson(
            name=case.name,
            description=case.description,
            error=case.error,
            envelope=made.hex(),
        )
    return InvalidJson(
        name=case.name, description=case.description, error=case.error, text=made
    )


def _sign1_structure_by_cbor2(protected: bytes, payload: bytes) -> bytes:
    # Built here, not imported from the codec, so the vectors cross-check it.
    return cbor2.dumps(["Signature1", protected, b"", payload], canonical=True)


def _registration_vector(case: RegistrationCase) -> RegistrationJson:
    key = KEYS[case.key]
    proof = key.registration_proof(case.account)
    assert len(proof) == REGISTRATION_PROOF_BYTES
    tagged = cbor2.loads(proof)
    assert tagged.tag == 18
    protected, unprotected, payload, signature = tagged.value
    assert unprotected == {}
    to_be_signed = _sign1_structure_by_cbor2(protected, payload)
    _check_with_cryptography(key.public_key, signature, to_be_signed)
    assert pycose_verifies_registration(proof, key.public_key)
    return RegistrationJson(
        name=case.name,
        description=case.description,
        key=case.key,
        account=str(case.account),
        protected=protected.hex(),
        payload=payload.hex(),
        to_be_signed=to_be_signed.hex(),
        signature=signature.hex(),
        proof=proof.hex(),
    )


def result_json(result: MatchResult) -> ResultJson:
    return ResultJson(
        match=str(result.match),
        best_of=result.best_of,
        rated=result.rated,
        players=[str(player) for player in result.players],
        games=[list(game) for game in result.games],
        ending=result.ending.kind,
        retired_by=result.ending.by if isinstance(result.ending, Retired) else None,
        replaces=result.replaces.hex() if result.replaces is not None else None,
    )


def result_from_json(value: ResultJson) -> MatchResult:
    first, second = value["players"]
    retired_by = value["retired_by"]
    return MatchResult(
        match=MatchId(UUID(value["match"])),
        best_of=value["best_of"],
        rated=value["rated"],
        players=(PlayerId(UUID(first)), PlayerId(UUID(second))),
        games=tuple((a, b) for a, b in value["games"]),
        ending=Completed() if retired_by is None else Retired(by=retired_by),
        replaces=(
            ResultHash(bytes.fromhex(value["replaces"]))
            if value["replaces"] is not None
            else None
        ),
    )


def public_keys(vectors: VectorsJson) -> list[SigningPublicKey]:
    return [
        SigningPublicKey(bytes.fromhex(k["x"]), bytes.fromhex(k["y"]))
        for k in vectors["keys"].values()
    ]


# pycose's SignMessage.encode() signs again for every signer, so it can't
# append to a received message: pycose_append() makes one COSE_Signature and
# splices it in with cbor2. pycose's package doesn't re-export its classes,
# so mypy needs the submodule imports.


def _pycose_key(
    key: SigningPublicKey, private: SigningPrivateKey | None = None
) -> EC2Key:
    if private is None:
        return EC2Key(crv="P_256", x=key.x, y=key.y)
    return EC2Key(crv="P_256", x=key.x, y=key.y, d=private.d)


def _pycose_message(envelope: bytes) -> SignMessage:
    tagged = cbor2.loads(envelope)
    assert tagged.tag == 98
    return cast(SignMessage, SignMessage.from_cose_obj(_thaw(tagged.value), True))


def pycose_append(envelope: bytes, key: SigningPrivateKey, player: PlayerId) -> bytes:
    parts = _parts(envelope)
    players: list[bytes] = _payload_of(parts)[DOMAIN_TAG][4]
    side = players.index(player.bytes)
    signer = CoseSignature(
        phdr={Algorithm: Es256, KID: key.public_key.kid, "player": side}
    )
    signer.key = _pycose_key(key.public_key, key)
    message = SignMessage(phdr={}, payload=parts[PAYLOAD], signers=[signer])
    parts[SIGNATURES].append(_parts(message.encode())[SIGNATURES][0])
    return _assemble(parts)


def pycose_sign1(proof: bytes) -> Sign1Message:
    tagged = cbor2.loads(proof)
    assert tagged.tag == 18
    return Sign1Message.from_cose_obj(_thaw(tagged.value), True)


def pycose_verifies_registration(proof: bytes, key: SigningPublicKey) -> bool:
    """Whether pycose reads `proof` as a COSE_Sign1 by `key` and verifies it."""
    message = pycose_sign1(proof)
    if message.phdr.get(KID) != key.kid:
        return False
    message.key = _pycose_key(key)
    verified: bool = message.verify_signature()
    return verified


def pycose_verifies(envelope: bytes, keys: Iterable[SigningPublicKey]) -> bool:
    by_kid = {key.kid: key for key in keys}
    for signer in _pycose_message(envelope).signers:
        key = by_kid.get(signer.phdr[KID])
        if key is None:
            return False
        signer.key = _pycose_key(key)
        if not signer.verify_signature():
            return False
    return True


if __name__ == "__main__":
    main()
