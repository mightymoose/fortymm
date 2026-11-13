"""Run the golden vectors through the core's Python module.

    python check_vectors.py <vectors.json> <fortymm_core.pyi>

with the built module on PYTHONPATH. The ids, the outcome ids and the
checksum are also recomputed here independently, with hashlib and a plain
polynomial division, so a wrong label or checksum in the core cannot pass by
agreeing with itself.
"""

import ast
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
    # The getters: each gives the vector's value, or None when it has none.
    def hexed(value: object) -> object:
        if isinstance(value, bytes):
            return value.hex()
        if isinstance(value, list):
            return [hexed(item) for item in value]
        return value

    check(record.signer.hex() == v["signer"], f"{name}: signer")
    for getter, value in [
        ("match_id", record.match_id()),
        ("extra_player_id", record.extra_player_id()),
        ("sides", record.sides),
        ("terms", record.terms),
        ("repeats_player", record.repeats_player),
        ("creator", record.creator),
        ("introduced_key", record.introduced_key),
    ]:
        check(hexed(value) == v.get(getter), f"{name}: {getter}")
    if "match_id" in v or "extra_player_id" in v:
        check(v["id"] in (v.get("match_id"), v.get("extra_player_id")), f"{name}: id is the record id")
    if "sides" in v:
        # The sides and terms are the body's own bytes: each player id, and
        # the terms, appear in it as a CBOR byte string.
        for player in [p for side in record.sides for p in side]:
            check(b"\x58\x20" + player in record.body, f"{name}: player id in the body")
        check(record.terms in record.body, f"{name}: terms in the body")

for v in vectors["usernames"]:
    check(
        core.username(unhex(v["player_id"]), v["suffix_length"]) == v["username"],
        f"username {v['player_id']} {v['suffix_length']}",
    )

for length in vectors["invalid_username_suffix_lengths"] + [-1]:
    try:
        core.username(bytes(32), length)
        check(False, f"username suffix length {length}: refused")
    except core.Malformed:
        check(True, "")

# The type stub names exactly what the module defines.
stub = ast.parse(open(sys.argv[2]).read())


def names(body: list[ast.stmt]) -> set[str]:
    found = set()
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            found.add(node.name)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            found.add(node.target.id)
    return found


def public(thing: object) -> set[str]:
    return {n for n in dir(thing) if not n.startswith("_")}


check(names(stub.body) == public(core), f"stub: module names {names(stub.body) ^ public(core)}")
for node in stub.body:
    if isinstance(node, ast.ClassDef) and node.name in ("Record", "Parcel"):
        cls = getattr(core, node.name)
        found = names(node.body) - {"__init__"}
        check(found == public(cls), f"stub: {node.name} names {found ^ public(cls)}")

for v in vectors["invalid_records"]:
    try:
        core.Record.decode(unhex(v["record"]))
        check(False, f"invalid {v['name']}: refused")
    except core.Malformed:
        check(True, "")

for v in vectors["unverifiable_records"]:
    check(not core.Record.decode(unhex(v["record"])).verify(), f"unverifiable {v['name']}")

# A hello made from its inputs: the same body and record as Rust, read back
# as a hello that introduces its signer.
for v in vectors["made_hellos"]:
    name = v["name"]
    signer = unhex(v["signer"])
    body = core.hello_body(v["environment"], signer, unhex(v["random"]), v["clock"])
    check(body.hex() == v["body"], f"made {name}: body")
    record = core.Record.from_parts(body, core.signature_from_raw(unhex(v["raw_signature"])))
    check(record.to_bytes().hex() == v["record"], f"made {name}: record")
    check(record.verify(), f"made {name}: verifies")
    check(record.kind_name == "hello", f"made {name}: kind")
    check(record.introduced_key == signer == record.signer, f"made {name}: introduces its signer")
    check(
        (record.match_id(), record.sides, record.terms, record.creator) == (None, None, None, None),
        f"made {name}: names no match",
    )


def refusal(run) -> str | None:
    try:
        run()
    except core.Malformed as error:
        return str(error)
    return None


# A bad key fails as it does wherever a key is taken (account_id).
for v in vectors["invalid_hello_inputs"]:
    got = refusal(lambda: core.hello_body(v["environment"], unhex(v["signer"]), unhex(v["random"])))
    if v["name"].startswith("signer-"):
        expected = refusal(lambda: core.account_id(unhex(v["signer"])))
    else:
        expected = "the random value is 8 bytes"
    check(got is not None and got == expected, f"invalid hello input {v['name']}: {got}, expected {expected}")

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
