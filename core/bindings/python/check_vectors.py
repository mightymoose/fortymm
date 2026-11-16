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
    if isinstance(node, ast.ClassDef) and node.name in ("Record", "Parcel", "Terms", "ScoreValue", "MatchState"):
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

# ---- Making a `player`, a `match` and a `score`, and reading a score ----
#
# The made records are signed by the Rust tests' software keys: the vectors
# hold each body's raw signature.

SCORE_GETTERS = ("scored_match", "slot", "value", "replaces")


def hexes(value: object) -> object:
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, list):
        return [hexes(item) for item in value]
    return value


def body_of(v: dict, **replaced: object) -> bytes:
    """The body a made record's vector describes, with any input replaced."""
    i = {**v, **replaced}
    signer, random = unhex(i["signer"]), unhex(i["random"])
    if i["kind_name"] == "player":
        return core.player_body(i["environment"], signer, random, i["clock"])
    if i["kind_name"] == "match":
        sides = [[unhex(p) for p in side] for side in i["sides"]]
        return core.match_body(i["environment"], signer, random, sides, unhex(i["terms"]), i["clock"])
    return core.score_body(
        i["environment"],
        signer,
        random,
        unhex(i["scored_match"]),
        i["slot"],
        unhex(i["value"]),
        [unhex(r) for r in i["replaces"]],
        i["clock"],
    )


vector = {v["name"]: v for v in vectors["made_records"]}

# B1. Each body, signed and assembled, verifies and is of its kind. Same bytes
# as Rust.
made = {}
for v in vectors["made_records"]:
    name = v["name"]
    body = body_of(v)
    check(body.hex() == v["body"], f"made {name}: body")
    record = core.Record.from_parts(body, core.signature_from_raw(unhex(v["raw_signature"])))
    check(record.to_bytes().hex() == v["record"], f"made {name}: record")
    check(record.verify(), f"made {name}: verifies")
    check(record.kind_name == v["kind_name"], f"made {name}: kind is {record.kind_name}")
    check(record.id().hex() == v["id"] == sha(body), f"made {name}: id")
    made[name] = record
# The clock is optional, as hello_body's is.
p = vector["player"]
check(
    core.player_body(p["environment"], unhex(p["signer"]), unhex(p["random"])).hex() == p["body"],
    "made player: no clock given",
)

# B2. A made match gives back its sides and terms through the existing
# getters, and a made player's extra player can be a side.
v = vector["match"]
check(hexes(made["match"].sides) == v["sides"], "made match: sides")
check(hexes(made["match"].terms) == v["terms"], "made match: terms")
check(hexes(made["match"].match_id()) == v["id"], "made match: its id is the record id")
players = [p for side in made["match"].sides for p in side]
for name in ("player", "player-with-clock"):
    extra = made[name].extra_player_id()
    check(extra is not None and extra in players, f"made match: {name}'s extra player is a side")
check(
    made["player"].extra_player_id() != made["player-with-clock"].extra_player_id(),
    "made players: two random values, two players",
)

# B3. A made score gives back its match, slot, value and replaced ids; those
# getters give nothing for another kind.
for v in vectors["made_records"]:
    if v["kind_name"] != "score":
        continue
    name, record = v["name"], made[v["name"]]
    check(hexes(record.scored_match) == v["scored_match"], f"made {name}: scored_match")
    check(record.scored_match == made["match"].match_id(), f"made {name}: is about the made match")
    check(record.slot == v["slot"], f"made {name}: slot")
    check(hexes(record.value) == v["value"], f"made {name}: value")
    check(hexes(record.replaces) == v["replaces"], f"made {name}: replaces")
    check(record.match_id() is None, f"made {name}: is not a match")
check(made["score-replacing"].replaces == [made["score"].id()], "made score-replacing: replaces the made score")
others = [(f"made {v['name']}", made[v["name"]]) for v in vectors["made_records"] if v["kind_name"] != "score"]
others += [(f"made {v['name']}", core.Record.decode(unhex(v["record"]))) for v in vectors["made_hellos"]]
for name, record in others:
    for getter in SCORE_GETTERS:
        check(getattr(record, getter) is None, f"{name}: {getter} is None")
# The same over every record vector: its value, or None when it has none.
for v in vectors["records"]:
    record = core.Record.decode(unhex(v["record"]))
    for getter in SCORE_GETTERS:
        got = hexes(getattr(record, getter))
        check(got == v.get(getter), f"{v['name']}: {getter} gave {got}")

# B5. A key or a random value of the wrong length raises Malformed, with the
# reason hello_body gives.
for bad in vectors["invalid_hello_inputs"]:
    expected = refusal(lambda: core.hello_body(bad["environment"], unhex(bad["signer"]), unhex(bad["random"])))
    for name in ("player", "match", "score"):
        got = refusal(lambda: body_of(vector[name], signer=bad["signer"], random=bad["random"]))
        check(
            got is not None and got == expected,
            f"invalid {name} input {bad['name']}: {got}, expected {expected}",
        )
# The other inputs are checked too: ids are 32 bytes, and a match has two
# sides with a player each.
ID = "00" * 32
for what, name, replaced in [
    ("a player id of 31 bytes", "match", {"sides": [[ID[2:]], [ID]]}),
    ("a player id of 33 bytes", "match", {"sides": [[ID], [ID, ID + "00"]]}),
    ("an empty side", "match", {"sides": [[ID], []]}),
    ("one side", "match", {"sides": [[ID]]}),
    ("three sides", "match", {"sides": [[ID], [ID], [ID]]}),
    ("a match id of 31 bytes", "score", {"scored_match": ID[2:]}),
    ("a replaced id of 33 bytes", "score", {"replaces": [ID + "00"]}),
]:
    check(refusal(lambda: body_of(vector[name], **replaced)) is not None, f"{name} body with {what}: refused")

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

# The product layouts: each value gives the vector's bytes and reads back
# from them; bytes of another version or damaged read as None.
for v in vectors["terms"]:
    what = f"terms best of {v['best_of']} rated {v['rated']}"
    check(core.terms_bytes(v["best_of"], v["rated"]).hex() == v["bytes"], f"{what}: bytes")
    terms = core.read_terms(unhex(v["bytes"]))
    check(
        terms is not None and (terms.best_of, terms.rated) == (v["best_of"], v["rated"]),
        f"{what}: read {terms}",
    )
    check(terms == core.read_terms(unhex(v["bytes"])), f"{what}: equal to itself read again")

for v in vectors["unreadable_terms"]:
    check(core.read_terms(unhex(v["bytes"])) is None, f"unreadable terms {v['name']}: None")

for best_of in vectors["invalid_best_ofs"] + [-1, 2**32 + 1]:
    check(refusal(lambda: core.terms_bytes(best_of, False)) is not None, f"terms_bytes {best_of}: refused")

for v in vectors["score_values"]:
    score = None if v["score"] is None else (v["score"][0], v["score"][1])
    what = f"score value {score}"
    check(core.score_value(score).hex() == v["bytes"], f"{what}: bytes")
    value = core.read_score_value(unhex(v["bytes"]))
    check(value is not None and value.score == score, f"{what}: read {value}")

for v in vectors["unreadable_score_values"]:
    check(core.read_score_value(unhex(v["bytes"])) is None, f"unreadable score value {v['name']}: None")

for score in [(-1, 0), (11, 2**32)]:
    check(refusal(lambda: core.score_value(score)) is not None, f"score_value {score}: refused")

# A match's state from each set of records, as Rust gives it: a corrected
# game (C2), a gap and a clear at the end (C3), the current ids (C4).
for v in vectors["match_states"]:
    state = core.match_state([core.Record.decode(unhex(r)) for r in v["records"]])
    check(state is not None, f"match state {v['name']}: a state")
    if state is None:
        continue
    # The stub's types, not only the values: each game None or a tuple of two
    # ints (a list would compare equal below, but can't be hashed).
    check(
        all(
            g is None or (type(g) is tuple and len(g) == 2 and all(type(p) is int for p in g))
            for g in state.games
        ),
        f"match state {v['name']}: games are None or tuple[int, int], gave {state.games!r}",
    )
    terms = None if state.terms is None else {"best_of": state.terms.best_of, "rated": state.terms.rated}
    got = {
        "match_id": state.match_id.hex(),
        "creator": state.creator.hex(),
        "sides": [[p.hex() for p in side] for side in state.sides],
        "terms": terms,
        "games": [None if g is None else list(g) for g in state.games],
        "current": [[i.hex() for i in ids] for ids in state.current],
    }
    for field in ("match_id", "creator", "sides", "terms", "games", "current"):
        check(got[field] == v["state"][field], f"match state {v['name']}: {field} gave {got[field]}")

# No match record, no state.
first = [core.Record.decode(unhex(r)) for r in vectors["match_states"][0]["records"]]
check(core.match_state([r for r in first if r.kind_name == "score"]) is None, "match state without a match: None")
check(core.match_state([]) is None, "match state of no records: None")

print(f"Python {sys.version.split()[0]}, module {core.__file__}: {checks} checks")
if failures:
    sys.exit(f"{failures} checks failed")
print("all golden vectors pass")
