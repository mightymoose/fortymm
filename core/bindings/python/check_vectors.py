"""Run the golden vectors through the core's Python module.

    python check_vectors.py <vectors.json>

with the built module on PYTHONPATH. The ids, the outcome ids and the
checksum are also recomputed here independently, with hashlib and a plain
polynomial division, so a wrong label or checksum in the core cannot pass by
agreeing with itself.
"""

import hashlib
import json
import sys

import fortymm_core as core

vectors = json.load(open(sys.argv[1]))
failures = 0
checks = 0


def check(condition: bool, what: str) -> None:
    global failures, checks
    checks += 1
    if not condition:
        failures += 1
        print(f"  FAIL {what}", file=sys.stderr)


def unhex(text: str) -> bytes:
    return bytes.fromhex(text)


def crc32c_msb_first(data: bytes) -> int:
    """CRC-32C, most significant bit first, as long division of polynomials
    over GF(2): no table and no code shared with the core. With initial
    register I (all ones) and an n-bit message M, the register ends as
    (I * x^n + M * x^32) mod P; the result is that, inverted."""
    poly = (1 << 32) | 0x1EDC6F41
    n = len(data) * 8
    value = (0xFFFFFFFF << n) ^ (int.from_bytes(data, "big") << 32)
    for shift in range(value.bit_length() - 1, 31, -1):
        if value >> shift & 1:
            value ^= poly << (shift - 32)
    return value ^ 0xFFFFFFFF


labels = {name: unhex(text) for name, text in vectors["labels"].items()}
check(labels["account"] == b"fortymm.account.v1\0", "account label")
check(labels["own_player"] == b"fortymm.own-player.v1\0", "own player label")
check(labels["outcome"] == b"fortymm.outcome.v1\0", "outcome label")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


for v in vectors["records"]:
    record = core.Record.decode(unhex(v["record"]))
    name = v["name"]
    check(record.to_bytes().hex() == v["record"], f"{name}: re-encodes")
    check(record.body.hex() == v["body"], f"{name}: body")
    check(record.signature.hex() == v["signature"], f"{name}: signature")
    check(record.id().hex() == v["id"] == sha(record.body), f"{name}: id")
    check(record.verify(), f"{name}: verifies")
    check(record.kind == v["kind"] and record.kind_name == v["kind_name"], f"{name}: kind")
    check(record.interpreted == v["interpreted"], f"{name}: interpreted")
    signer = unhex(v["signer"])
    check(
        record.signer_account_id().hex() == v["signer_account_id"] == sha(labels["account"] + signer),
        f"{name}: account id",
    )
    check(
        record.signer_own_player_id().hex()
        == v["signer_own_player_id"]
        == sha(labels["own_player"] + signer),
        f"{name}: own player id",
    )
    check(core.account_id(signer).hex() == v["signer_account_id"], f"{name}: account_id()")
    outcome = record.outcome_id()
    check((outcome.hex() if outcome else None) == v.get("outcome_id"), f"{name}: outcome id")
    if "subject" in v:
        check(sha(labels["outcome"] + unhex(v["subject"])) == v["outcome_id"], f"{name}: outcome preimage")
        check(unhex(v["subject"]) in record.body, f"{name}: subject is a slice of the body")
    if "match_id" in v:
        check(record.match_id().hex() == v["match_id"] == v["id"], f"{name}: match id")
    is_match = v["kind_name"] == "match" and v["interpreted"]
    check((record.sides is not None) == is_match, f"{name}: sides only on a match")
    check((record.terms is not None) == is_match, f"{name}: terms only on a match")
    if is_match:
        # The sides and terms are the body's own bytes: each player id, and
        # the terms, appear in it as a CBOR byte string.
        for player in [p for side in record.sides for p in side]:
            check(len(player) == 32 and b"\x58\x20" + player in record.body, f"{name}: player id")
        check(record.terms in record.body, f"{name}: terms")
    if "extra_player_id" in v:
        check(record.extra_player_id().hex() == v["extra_player_id"] == v["id"], f"{name}: player id")

check((core.PRODUCTION, core.UAT, core.DEVELOPMENT) == (1, 2, 3), "environment numbers")

for v in vectors["invalid_records"]:
    try:
        core.Record.decode(unhex(v["record"]))
        check(False, f"invalid {v['name']}: refused")
    except core.Malformed:
        check(True, "")

for v in vectors["unverifiable_records"]:
    check(not core.Record.decode(unhex(v["record"])).verify(), f"unverifiable {v['name']}")

by_name = {}
for v in vectors["parcels"]:
    by_name[v["name"]] = v
    for form in ("text", "link"):
        parcel = core.Parcel.parse(v[form])
        check(parcel.to_binary().hex() == v["binary"], f"parcel {v['name']} ({form}): binary")
        check(parcel.text() == v["text"], f"parcel {v['name']}: text")
        check(parcel.link("fortymm.example") == v["link"], f"parcel {v['name']}: link")
        check([r.to_bytes().hex() for r in parcel.records] == v["records"], f"parcel {v['name']}: records")
    built = core.Parcel(v["environment"], [core.Record.decode(unhex(r)) for r in v["records"]])
    check(built.to_binary().hex() == v["binary"], f"parcel {v['name']}: built")
    binary = unhex(v["binary"])
    stored = int.from_bytes(binary[-4:], "big")
    check(crc32c_msb_first(binary[:-4]) == stored == core.checksum(binary[:-4]), f"parcel {v['name']}: checksum")
    # The smallest limit, doubling from 400, that the parcel can be split to.
    limit = 400
    while True:
        try:
            parts = built.split(limit)
            break
        except core.Malformed:
            limit *= 2
    seen = {r.to_bytes().hex() for part in parts for r in part.records}
    check(set(v["records"]) <= seen, f"parcel {v['name']}: split keeps every record")
    check(all(len(part.text()) <= limit for part in parts), f"parcel {v['name']}: split sizes")

for v in vectors["harmless_parcel_texts"]:
    check(core.Parcel.parse(v["text"]).to_binary().hex() == by_name[v["parcel"]]["binary"], f"harmless {v['name']}")

for v in vectors["damaged_parcel_texts"]:
    try:
        core.Parcel.parse(v["text"])
        check(False, f"damaged {v['name']}: refused")
    except core.Damaged:
        check(True, "")

for v in vectors["signatures"]:
    if "der" in v:
        check(core.signature_from_der(unhex(v["der"])).hex() == v["stored"], f"signature der {v['key']}")
    check(core.signature_from_raw(unhex(v["raw"])).hex() == v["stored"], f"signature raw {v['key']}")

for v in vectors["invalid_der"]:
    try:
        core.signature_from_der(unhex(v["der"]))
        check(False, f"invalid der {v['name']}")
    except core.Malformed:
        check(True, "")

for v in vectors["checksums"]:
    data = unhex(v["input"])
    check(f"{core.checksum(data):08x}" == v["checksum"], f"checksum {v['input']}")
    check(f"{crc32c_msb_first(data):08x}" == v["checksum"], f"independent checksum {v['input']}")

print(f"Python {sys.version.split()[0]}, module {core.__file__}: {checks} checks")
if failures:
    sys.exit(f"{failures} checks failed")
print("all golden vectors pass")
