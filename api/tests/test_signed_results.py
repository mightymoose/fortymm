import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, get_args
from uuid import UUID

import cbor2
import pytest
from signed_result_vectors import (
    PAYLOAD,
    SIGNATURE,
    SIGNATURES,
    VECTORS_PATH,
    InvalidJson,
    ValidJson,
    VectorsJson,
    build,
    public_keys,
    pycose_append,
    pycose_verifies,
    render,
    replace_payload,
    result_from_json,
)

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.signed_results import (
    BadSignature,
    Completed,
    Malformed,
    MatchResult,
    RefusalCode,
    ResultHash,
    Retired,
    SignedResultRefused,
    UnknownKey,
    append_signature,
    decode_envelope,
    encode_payload,
    envelope_from_text,
    link,
    qr_text,
    sign,
)
from fortymm_api.signing_keys import SigningPrivateKey

ANN_KEY = SigningPrivateKey(hashlib.sha256(b"ann's key").digest())
BO_KEY = SigningPrivateKey(hashlib.sha256(b"bo's key").digest())
ANN = PlayerId(UUID(int=1))
BO = PlayerId(UUID(int=2))
CY = PlayerId(UUID(int=3))
ISSUED_AT = datetime(2026, 11, 1, 12, tzinfo=UTC)
RESULT = MatchResult(
    match=MatchId(UUID(int=99)),
    best_of=3,
    rated=True,
    players=(ANN, BO),
    games=((11, 7), (9, 11), (11, 4)),
    ending=Completed(),
)
KEYS = [ANN_KEY.public_key, BO_KEY.public_key]

VECTORS: VectorsJson = json.loads(VECTORS_PATH.read_text())
DIRECTORY = public_keys(VECTORS)
# ISO/IEC 18004 table 7: alphanumeric characters at version 16, error level
# M, with no mode switching. Version 14 at level L holds 667, so the budget
# fits that too.
QR_VERSION_16_M_ALPHANUMERIC = 656

valid = pytest.mark.parametrize("vector", VECTORS["valid"], ids=lambda v: v["name"])
multi_signed = pytest.mark.parametrize(
    "vector",
    [v for v in VECTORS["valid"] if len(v["signatures"]) > 1],
    ids=lambda v: v["name"],
)
invalid = pytest.mark.parametrize("vector", VECTORS["invalid"], ids=lambda v: v["name"])


def _envelope(vector: ValidJson) -> bytes:
    return bytes.fromhex(vector["envelope"])


def test_the_committed_vectors_are_fresh() -> None:
    assert VECTORS_PATH.read_text() == render(build()), (
        "api/signed-results/vectors.json differs from the generator's output."
        " Run ./bin/mise run api:signed-result-vectors and commit it. Changing"
        " an existing vector's bytes breaks every client that checks them."
    )


@valid
def test_verifies_every_valid_vector(vector: ValidJson) -> None:
    verified = decode_envelope(_envelope(vector)).verify(DIRECTORY)

    assert verified.hash.hex() == vector["hash"]
    assert verified.result == result_from_json(vector["result"])
    assert verified.issued_at == datetime.fromtimestamp(vector["issued_at"], UTC)
    assert {(a.kid.hex(), str(a.player)) for a in verified.approvals} == {
        (a["kid"], a["player"]) for a in vector["approvals"]
    }


@valid
def test_encodes_every_valid_payload(vector: ValidJson) -> None:
    result = result_from_json(vector["result"])
    issued_at = datetime.fromtimestamp(vector["issued_at"], UTC)

    assert encode_payload(result, issued_at).hex() == vector["payload"]
    assert (
        hashlib.sha256(bytes.fromhex(vector["payload"])).hexdigest() == vector["hash"]
    )


@valid
def test_writes_and_reads_every_qr_text_and_link(vector: ValidJson) -> None:
    envelope = _envelope(vector)

    assert qr_text(envelope) == vector["qr"]
    assert link(envelope) == vector["link"]
    assert envelope_from_text(vector["qr"]) == envelope
    assert envelope_from_text(vector["link"]) == envelope


@valid
def test_pycose_verifies_every_valid_envelope(vector: ValidJson) -> None:
    assert pycose_verifies(_envelope(vector), DIRECTORY)


def _without_the_last_signature(vector: ValidJson) -> bytes:
    body = cbor2.loads(_envelope(vector)).value
    signatures = [list(s) for s in body[SIGNATURES][:-1]]
    return cbor2.dumps(
        cbor2.CBORTag(98, [b"", {}, body[PAYLOAD], signatures]), canonical=True
    )


def _last_signer(vector: ValidJson) -> tuple[SigningPrivateKey, PlayerId]:
    last = vector["signatures"][-1]
    key = SigningPrivateKey(bytes.fromhex(VECTORS["keys"][last["key"]]["d"]))
    return key, PlayerId(UUID(last["player"]))


@multi_signed
def test_pycose_appends_the_last_signature_byte_for_byte(vector: ValidJson) -> None:
    key, player = _last_signer(vector)

    appended = pycose_append(_without_the_last_signature(vector), key, player)

    assert appended == _envelope(vector)


@multi_signed
def test_the_codec_appends_the_last_signature_byte_for_byte(vector: ValidJson) -> None:
    key, player = _last_signer(vector)

    appended = append_signature(_without_the_last_signature(vector), key, player)

    assert appended == _envelope(vector)


@invalid
def test_refuses_every_invalid_vector(vector: InvalidJson) -> None:
    with pytest.raises(SignedResultRefused) as refused:
        envelope = (
            envelope_from_text(vector["text"])
            if "text" in vector
            else bytes.fromhex(vector["envelope"])
        )
        decode_envelope(envelope).verify(DIRECTORY)
    assert refused.value.code == vector["error"]


@pytest.mark.parametrize(
    "vector",
    [v for v in VECTORS["invalid"] if v["error"] != "malformed"],
    ids=lambda v: v["name"],
)
def test_a_well_formed_invalid_vector_still_decodes(vector: InvalidJson) -> None:
    decode_envelope(bytes.fromhex(vector["envelope"]))


def test_the_vectors_cover_every_refusal_code() -> None:
    codes = set(get_args(RefusalCode.__value__))

    assert {v["error"] for v in VECTORS["invalid"]} == codes


def test_an_unknown_key_is_reported_before_a_bad_signature() -> None:
    unlisted = SigningPrivateKey(hashlib.sha256(b"an unlisted key").digest())
    envelope = append_signature(sign(RESULT, ISSUED_AT, ANN_KEY, ANN), unlisted, BO)

    def tamper(claims: dict[Any, Any]) -> None:
        claims[6] += 1

    with pytest.raises(UnknownKey):
        decode_envelope(replace_payload(envelope, tamper)).verify(KEYS)


@pytest.mark.parametrize("name", VECTORS["keys"])
def test_derives_every_key(name: str) -> None:
    expected = VECTORS["keys"][name]
    key = SigningPrivateKey(bytes.fromhex(expected["d"])).public_key

    assert key.x.hex() == expected["x"]
    assert key.y.hex() == expected["y"]
    assert key.to_cose_key().hex() == expected["cose_key"]
    assert key.kid.hex() == expected["kid"]


def test_the_first_vector_matches_the_spec_example() -> None:
    # The vectors are generated, so a mistake made in both encode_payload and
    # decode_envelope would regenerate cleanly. This literal catches it.
    first = VECTORS["valid"][0]
    players = first["result"]["players"]

    assert cbor2.loads(bytes.fromhex(first["payload"])) == {
        6: 1793534400,
        "fortymm/match-result/v1": {
            1: UUID(first["result"]["match"]).bytes,
            2: 3,
            3: True,
            4: [UUID(players[0]).bytes, UUID(players[1]).bytes],
            5: [[11, 7], [9, 11], [11, 4]],
            6: 0,
        },
    }


def test_every_two_signature_qr_text_fits_version_16_at_level_m() -> None:
    # The budget covers the two players' approvals, the case the issue names.
    # A third signature, a representative's, adds 116 bytes and needs version
    # 17 at level M.
    two_signatures = [v for v in VECTORS["valid"] if len(v["signatures"]) <= 2]

    assert len(two_signatures) >= 2
    assert max(len(v["qr"]) for v in two_signatures) <= QR_VERSION_16_M_ALPHANUMERIC


def test_both_players_signatures_verify_as_two_approvals() -> None:
    envelope = append_signature(sign(RESULT, ISSUED_AT, ANN_KEY, ANN), BO_KEY, BO)

    verified = decode_envelope(envelope).verify(KEYS)

    assert verified.result == RESULT
    assert verified.issued_at == ISSUED_AT
    assert verified.hash == hashlib.sha256(encode_payload(RESULT, ISSUED_AT)).digest()
    assert {(a.kid, a.player) for a in verified.approvals} == {
        (ANN_KEY.public_key.kid, ANN),
        (BO_KEY.public_key.kid, BO),
    }


def test_append_signature_keeps_the_received_payload_bytes() -> None:
    half = sign(RESULT, ISSUED_AT, ANN_KEY, ANN)

    full = append_signature(half, BO_KEY, BO)

    half_body = cbor2.loads(half).value
    full_body = cbor2.loads(full).value
    assert full_body[PAYLOAD] == half_body[PAYLOAD]
    assert full_body[SIGNATURES][0] == half_body[SIGNATURES][0]
    assert len(full_body[SIGNATURES]) == 2


def test_the_envelope_names_the_keys_to_look_up() -> None:
    envelope = append_signature(sign(RESULT, ISSUED_AT, ANN_KEY, ANN), BO_KEY, BO)

    assert decode_envelope(envelope).kids == {
        ANN_KEY.public_key.kid,
        BO_KEY.public_key.kid,
    }


def test_verify_refuses_a_kid_with_no_key() -> None:
    envelope = append_signature(sign(RESULT, ISSUED_AT, ANN_KEY, ANN), BO_KEY, BO)

    with pytest.raises(UnknownKey) as refused:
        decode_envelope(envelope).verify([ANN_KEY.public_key])
    assert refused.value.kids == {BO_KEY.public_key.kid}


def test_verify_refuses_a_signature_by_another_key() -> None:
    envelope = sign(RESULT, ISSUED_AT, ANN_KEY, ANN)
    impostor = SigningPrivateKey(hashlib.sha256(b"an impostor's key").digest())
    body = cbor2.loads(envelope).value
    forged = [list(body[SIGNATURES][0])]
    forged[0][SIGNATURE] = impostor.sign(b"something else")
    forged_envelope = cbor2.dumps(
        cbor2.CBORTag(98, [b"", {}, body[PAYLOAD], forged]), canonical=True
    )

    with pytest.raises(BadSignature) as refused:
        decode_envelope(forged_envelope).verify(KEYS)
    assert refused.value.kid == ANN_KEY.public_key.kid


def test_a_retirement_and_a_correction_round_trip() -> None:
    result = MatchResult(
        match=MatchId(UUID(int=100)),
        best_of=5,
        rated=False,
        players=(ANN, BO),
        games=((11, 8), (7, 5)),
        ending=Retired(by=1),
        replaces=ResultHash(hashlib.sha256(b"the first result").digest()),
    )

    verified = decode_envelope(sign(result, ISSUED_AT, BO_KEY, BO)).verify(KEYS)

    assert verified.result == result


def test_the_qr_text_and_the_link_read_back_to_the_envelope() -> None:
    envelope = sign(RESULT, ISSUED_AT, ANN_KEY, ANN)

    assert qr_text(envelope).startswith("FMR1:")
    assert link(envelope).startswith("https://fortymm.com/r#")
    assert envelope_from_text(qr_text(envelope)) == envelope
    assert envelope_from_text(link(envelope)) == envelope


@pytest.mark.parametrize(
    ("data", "encoded"),
    [
        (b"AB", "BB8"),
        (b"Hello!!", "%69 VD92EX0"),
        (b"base-45", "UJCLQE7W581"),
        (b"ietf!", "QED8WEX0"),
    ],
    ids=["AB", "Hello!!", "base-45", "ietf!"],
)
def test_base45_matches_the_rfc_9285_examples(data: bytes, encoded: str) -> None:
    assert qr_text(data) == "FMR1:" + encoded
    assert envelope_from_text("FMR1:" + encoded) == data


@pytest.mark.parametrize(
    "text",
    [
        "FMR2:BB8",
        "FMR1:GGW",
        "FMR1:BB8B",
        "FMR1:bb8",
        "https://fortymm.com/r#QUI=",
        "https://fortymm.com/r#QUJ",
        "https://fortymm.com/r#QU+/",
        "https://fortymm.com/r#QU I",
        "FMR1",
    ],
    ids=[
        "another QR prefix",
        "a Base45 group over 65535",
        "Base45 of 1 mod 3 characters",
        "lowercase Base45",
        "padded base64url",
        "nonzero spare bits",
        "the standard base64 alphabet",
        "a character outside base64url",
        "no prefix",
    ],
)
def test_envelope_from_text_refuses_a_text_that_is_not_canonical(text: str) -> None:
    with pytest.raises(Malformed):
        envelope_from_text(text)


@pytest.mark.parametrize(
    "changes",
    [
        {"players": (ANN, ANN)},
        {"games": ((11, 1), (11, 2), (11, 3), (11, 4))},
        {"games": ((11, -1),)},
        {"replaces": ResultHash(b"short")},
    ],
    ids=[
        "equal players",
        "more games than best_of",
        "negative points",
        "short replaces",
    ],
)
def test_a_result_refuses_what_its_types_cant_hold(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        replace(RESULT, **changes)


@pytest.mark.parametrize(
    "issued_at",
    [
        datetime(2026, 11, 1, 12),
        datetime(2026, 11, 1, 12, microsecond=1, tzinfo=UTC),
        datetime(1969, 12, 31, tzinfo=UTC),
    ],
    ids=["no timezone", "microseconds", "before 1970"],
)
def test_encode_refuses_an_issued_at_the_payload_cant_carry(
    issued_at: datetime,
) -> None:
    with pytest.raises(ValueError, match="issued_at"):
        encode_payload(RESULT, issued_at)


def test_an_issued_at_in_another_timezone_decodes_as_the_same_instant() -> None:
    issued_at = ISSUED_AT.astimezone(timezone(timedelta(hours=2)))

    verified = decode_envelope(sign(RESULT, issued_at, ANN_KEY, ANN)).verify(KEYS)

    assert verified.issued_at == ISSUED_AT


def test_sign_refuses_a_player_outside_the_match() -> None:
    with pytest.raises(ValueError, match="isn't in the match"):
        sign(RESULT, ISSUED_AT, ANN_KEY, CY)


def test_append_signature_refuses_a_player_outside_the_match() -> None:
    envelope = sign(RESULT, ISSUED_AT, ANN_KEY, ANN)

    with pytest.raises(ValueError, match="isn't in the match"):
        append_signature(envelope, BO_KEY, CY)


def test_append_signature_refuses_an_envelope_that_is_not_this_format() -> None:
    with pytest.raises(Malformed):
        append_signature(b"\xd8\x62\x80", BO_KEY, BO)
