"""Write api/signed-results/vectors.json, the signed result test vectors that
every client's tests check: `./bin/mise run api:signed-result-vectors`.
tests/test_signed_results.py fails when the committed file differs from
build(). Changing an existing vector's bytes is a format change, which
breaks every client.

Keys, ids and times are fixed, and ECDSA is deterministic (RFC 6979). So
build() gives the same bytes every time.

The vectors are made with signed_results, except for these:
- One vector's second signature is made by pycose, the independent second
  implementation, over the received payload bytes.
- Each invalid vector is a valid one with one fault, made with cbor2
  directly. A malformed vector may keep a signature that its fault made
  stale. Malformed is decided before any signature is checked, so the stale
  signature doesn't change its code.

This module is also the tests' adapter to pycose.
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
from pycose.messages.signer import CoseSignature
from pycose.messages.signmessage import SignMessage

from fortymm_api.accounts import PlayerId
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
from fortymm_api.signing_keys import SigningPrivateKey, SigningPublicKey

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


class VectorsJson(TypedDict):
    format: str  # DOMAIN_TAG
    generated_by: str
    keys: dict[str, KeyJson]  # the key directory every vector verifies against
    valid: list[ValidJson]
    invalid: list[InvalidJson]


def _test_key(name: str) -> SigningPrivateKey:
    return SigningPrivateKey(
        hashlib.sha256(f"{DOMAIN_TAG} test key {name}".encode()).digest()
    )


# ann and bo are the players' devices. cy is a representative's, which
# approves for either player.
KEYS: dict[str, SigningPrivateKey] = {
    name: _test_key(name) for name in ("ann", "bo", "cy")
}
# Signs the unknown-kid vector. Not in the file.
UNLISTED = _test_key("unlisted")

_NS = uuid5(NAMESPACE_URL, "https://fortymm.com/signed-results/v1/vectors")
ANN = PlayerId(uuid5(_NS, "player ann"))
BO = PlayerId(uuid5(_NS, "player bo"))
MERGED = PlayerId(uuid5(_NS, "player merged later"))
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
# and the retirement add their keys. The QR budget is measured on it.
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
    signers: tuple[tuple[str, PlayerId], ...]  # (key name, player), in envelope order
    note: str | None = None
    # Who appends the last signature. The tests check every multi-signature
    # vector against pycose either way. This records only which bytes the
    # file holds.
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
    # Builds the bad input from the valid envelopes, by name: envelope bytes,
    # or a QR text or link.
    make: Callable[[dict[str, bytes]], bytes | str]


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
    """[protected, unprotected, payload, [[protected, unprotected,
    signature], ...]], as plain lists and dicts."""
    tagged = cbor2.loads(envelope)
    assert tagged.tag == 98
    parts: list[Any] = _thaw(tagged.value)
    return parts


def _assemble(parts: list[Any], tag: int = 98) -> bytes:
    return cbor2.dumps(cbor2.CBORTag(tag, parts), canonical=True)


def _payload_of(parts: list[Any]) -> dict[Any, Any]:
    claims: dict[Any, Any] = _thaw(cbor2.loads(parts[2]))
    return claims


def replace_payload(
    envelope: bytes, change: Callable[[dict[Any, Any]], None], *, canonical: bool = True
) -> bytes:
    """Decode the payload to plain dicts and lists, apply `change`, encode it
    again and put it back. The signatures stay as they were."""
    parts = _parts(envelope)
    claims = _payload_of(parts)
    change(claims)
    parts[2] = cbor2.dumps(claims, canonical=canonical)
    return _assemble(parts)


def replace_body(envelope: bytes, change: Callable[[list[Any]], None]) -> bytes:
    parts = _parts(envelope)
    change(parts)
    return _assemble(parts)


def replace_signer_header(
    envelope: bytes, index: int, change: Callable[[dict[Any, Any]], None]
) -> bytes:
    parts = _parts(envelope)
    header: dict[Any, Any] = _thaw(cbor2.loads(parts[3][index][0]))
    change(header)
    parts[3][index][0] = cbor2.dumps(header, canonical=True)
    return _assemble(parts)


def _sig_structure(protected: bytes, payload: bytes) -> bytes:
    return cbor2.dumps(["Signature", b"", protected, b"", payload], canonical=True)


def _cose_signature(payload: bytes, name: str, side: Side) -> list[Any]:
    """[protected, {}, signature] by the named key, made here with cbor2 and
    the key alone, for a payload the codec won't sign."""
    key = KEYS[name]
    protected = cbor2.dumps(
        {1: -7, 4: key.public_key.kid, "player": side}, canonical=True
    )
    return [protected, {}, key.sign(_sig_structure(protected, payload))]


def _reencoded_by_the_second_signer(envelopes: dict[str, bytes]) -> bytes:
    """The second signer decoded the payload, wrote the result map's keys in
    reverse order, and signed that. The first signature is now over other
    bytes, but the determinism check refuses the payload before any
    signature is checked."""
    parts = _parts(envelopes["half-signed"])
    claims = _payload_of(parts)
    claims[DOMAIN_TAG] = dict(reversed(list(claims[DOMAIN_TAG].items())))
    parts[2] = cbor2.dumps(claims, canonical=False)
    parts[3].append(_cose_signature(parts[2], "bo", 1))
    return _assemble(parts)


def _best_of_not_shortest(envelopes: dict[str, bytes]) -> bytes:
    """best_of 3 as the two bytes 0x18 0x03. cbor2 only writes the shortest
    form, so this is byte surgery on the pair (2: 3, 3: true)."""
    parts = _parts(envelopes["completed-best-of-3"])
    payload: bytes = parts[2]
    assert payload.count(b"\x02\x03\x03\xf5") == 1
    parts[2] = payload.replace(b"\x02\x03\x03\xf5", b"\x02\x18\x03\x03\xf5")
    return _assemble(parts)


def _indefinite_signature_array(envelopes: dict[str, bytes]) -> bytes:
    parts = _parts(envelopes["completed-best-of-3"])
    signatures = cbor2.dumps(parts[3], canonical=True)
    assert signatures[0] == 0x82
    parts[3] = []
    return _assemble(parts)[:-1] + b"\x9f" + signatures[1:] + b"\xff"


def _unknown_kid(envelopes: dict[str, bytes]) -> bytes:
    return append_signature(envelopes["half-signed"], UNLISTED, BO)


def _tampered_payload(envelopes: dict[str, bytes]) -> bytes:
    def change(claims: dict[Any, Any]) -> None:
        claims[6] += 1

    return replace_payload(envelopes["completed-best-of-3"], change)


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
        change(parts[3][index])

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
        _body_change("completed-best-of-3", _set_body(0, b"\xa0")),
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
        _body_change("completed-best-of-3", _set_body(3, [])),
    ),
    InvalidCase(
        "signer-unprotected-header-not-empty",
        "The second signer's kid is copied into its unprotected header.",
        "malformed",
        _body_change(
            "completed-best-of-3",
            _set_signature(1, _set_body(1, {4: KEYS["bo"].public_key.kid})),
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
        " decoder whose maps treat true as 1 (Python's dict does) accepts it.",
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
            lambda parts: parts[3][0].__setitem__(2, parts[3][0][2][:63]),
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
)


def build() -> VectorsJson:
    """Every vector, in table order. Each to_be_signed is worked out here
    with cbor2, separately from the codec, and checked with cryptography
    before it is written, so the file never carries a value that only the
    codec agrees with."""
    valid = [_valid_vector(case) for case in VALID]
    envelopes = {v["name"]: bytes.fromhex(v["envelope"]) for v in valid}
    return VectorsJson(
        format=DOMAIN_TAG,
        generated_by=GENERATED_BY,
        keys={name: _key_json(key) for name, key in KEYS.items()},
        valid=valid,
        invalid=[_invalid_vector(case, envelopes) for case in INVALID],
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
    assert parts[2] == payload
    signatures = [
        _signature_json(name, player, case.result, payload, cose_signature)
        for (name, player), cose_signature in zip(case.signers, parts[3], strict=True)
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
    to_be_signed = _sig_structure(protected, payload)
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
    """Raises InvalidSignature unless the raw r || s signature verifies."""
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


def result_json(result: MatchResult) -> ResultJson:
    """The readable form of a result: UUIDs as strings, hashes as hex."""
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
    """The inverse of result_json(). The tests encode each vector's payload
    from it, as a client does."""
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
    """The key directory every verifier resolves kids against."""
    return [
        SigningPublicKey(bytes.fromhex(k["x"]), bytes.fromhex(k["y"]))
        for k in vectors["keys"].values()
    ]


# pycose, the second implementation. Three things the adapter works around:
# cbor2 6 decodes a tag's contents as tuples and frozendicts, which pycose's
# decoder refuses (so thaw first); SignMessage.encode() signs again for every
# signer, so pycose can't append to a received message (so it makes one
# COSE_Signature, spliced in with cbor2); and pycose's package doesn't
# re-export its classes, so mypy needs the submodule imports.


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
    """Append, by pycose, a COSE_Signature over the envelope's own payload
    bytes."""
    parts = _parts(envelope)
    players: list[bytes] = _payload_of(parts)[DOMAIN_TAG][4]
    side = players.index(player.bytes)
    signer = CoseSignature(
        phdr={Algorithm: Es256, KID: key.public_key.kid, "player": side}
    )
    signer.key = _pycose_key(key.public_key, key)
    message = SignMessage(phdr={}, payload=parts[2], signers=[signer])
    parts[3].append(_parts(message.encode())[3][0])
    return _assemble(parts)


def pycose_verifies(envelope: bytes, keys: Iterable[SigningPublicKey]) -> bool:
    """Whether pycose verifies every signature of the envelope with the key
    its kid names."""
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
