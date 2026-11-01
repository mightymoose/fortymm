"""The signed result codec, checked against the committed vectors in
api/signed-results/vectors.json, which every client's tests also check."""

import hashlib
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import cbor2
import pytest

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.signed_results import (
    BadSignature,
    Completed,
    Malformed,
    MatchResult,
    ResultHash,
    Retired,
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
    assert full_body[2] == half_body[2]
    assert full_body[3][0] == half_body[3][0]
    assert len(full_body[3]) == 2


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
    forged = [list(body[3][0])]
    forged[0][2] = impostor.sign(b"something else")
    forged_envelope = cbor2.dumps(
        cbor2.CBORTag(98, [b"", {}, body[2], forged]), canonical=True
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
