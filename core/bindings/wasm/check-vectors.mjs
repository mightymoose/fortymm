// Run the golden vectors through a WebAssembly build of the core, from Node.
//
//   node check-vectors.mjs <vectors.json> <module.wasm>
//
// WebCrypto is hidden throughout: the module hashes and verifies by itself.

import { readFile } from "node:fs/promises";
import { inspect, isDeepStrictEqual } from "node:util";
import { Core, Damaged } from "./fortymm-core.mjs";

const [vectorsPath, path] = process.argv.slice(2);
const vectors = JSON.parse(await readFile(vectorsPath, "utf8"));

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const unhex = (text) => new Uint8Array(Buffer.from(text, "hex"));
// Values are compared with isDeepStrictEqual: by structure, with types kept
// apart (null is not undefined, a number is not a string, an array is not a
// tuple-like object). `shown` writes a value for a failure message, undefined
// included, which JSON.stringify would print as null.
const shown = (value) => inspect(value, { depth: null, breakLength: Infinity, maxArrayLength: null });

let failures = 0;
function check(condition, what) {
  if (!condition) {
    failures += 1;
    console.error(`  FAIL ${what}`);
  }
}

Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });

{
  const wasm = await readFile(path);
  const core = await Core.load(wasm);
  console.log(`${path}: ${wasm.length} bytes`);
  let checks = 0;

  for (const v of vectors.records) {
    const record = unhex(v.record);
    check(hex(core.decodeRecord(record)) === v.record, `${v.name}: re-encodes`);
    check(hex(core.body(record)) === v.body, `${v.name}: body`);
    check(hex(core.id(record)) === v.id, `${v.name}: id`);
    check(core.verify(record), `${v.name}: verifies`);
    const signer = unhex(v.signer);
    check(hex(core.accountId(signer)) === v.signer_account_id, `${v.name}: account id`);
    check(hex(core.ownPlayerId(signer)) === v.signer_own_player_id, `${v.name}: own player id`);
    const outcome = core.outcomeId(record);
    check((outcome && hex(outcome)) === (v.outcome_id ?? null), `${v.name}: outcome id`);
    checks += 7;
    // The getters: each gives the vector's value, or null when it has none.
    const hexed = (value) =>
      value instanceof Uint8Array ? hex(value) : Array.isArray(value) ? value.map(hexed) : value;
    check(hex(core.signer(record)) === v.signer, `${v.name}: signer`);
    check(hex(core.signerAccountId(record)) === v.signer_account_id, `${v.name}: signerAccountId`);
    check(hex(core.signerOwnPlayerId(record)) === v.signer_own_player_id, `${v.name}: signerOwnPlayerId`);
    for (const [getter, field] of [
      ["matchId", "match_id"],
      ["extraPlayerId", "extra_player_id"],
      ["sides", "sides"],
      ["terms", "terms"],
      ["repeatsPlayer", "repeats_player"],
      ["creator", "creator"],
      ["introducedKey", "introduced_key"],
    ]) {
      const got = hexed(core[getter](record));
      check(isDeepStrictEqual(got, v[field] ?? null), `${v.name}: ${getter} gave ${shown(got)}`);
    }
    checks += 10;
  }
  for (const v of vectors.usernames) {
    const name = core.username(unhex(v.player_id), v.suffix_length);
    check(name === v.username, `username ${v.player_id} ${v.suffix_length}: ${name}`);
    checks += 1;
  }
  for (const length of [...vectors.invalid_username_suffix_lengths, -1, 4.5, 2 ** 32 + 4]) {
    let refused = false;
    try { core.username(new Uint8Array(32), length); } catch (error) { refused = !(error instanceof Damaged); }
    check(refused, `username suffix length ${length}: refused`);
    checks += 1;
  }
  // The types name exactly the wrapper's methods (`call` and `optional` are
  // its own plumbing).
  {
    const types = await readFile(new URL("./fortymm-core.d.mts", import.meta.url), "utf8");
    const typed = new Set([...types.matchAll(/^  (?:static )?(\w+)\(/gm)].map((m) => m[1]));
    const methods = new Set([
      ...Object.getOwnPropertyNames(Core.prototype).filter((n) => !["constructor", "call", "optional"].includes(n)),
      ...Object.getOwnPropertyNames(Core).filter((n) => typeof Core[n] === "function"),
    ]);
    const differ = [...typed].filter((n) => !methods.has(n)).concat([...methods].filter((n) => !typed.has(n)));
    check(differ.length === 0, `types: names differ from the wrapper: ${differ.join(", ")}`);
    checks += 1;
  }
  for (const v of vectors.invalid_records) {
    let refused = false;
    try { core.decodeRecord(unhex(v.record)); } catch { refused = true; }
    check(refused, `invalid ${v.name}: refused`);
    checks += 1;
  }
  for (const v of vectors.unverifiable_records) {
    check(!(core.verify(unhex(v.record))), `unverifiable ${v.name}: does not verify`);
    checks += 1;
  }
  // A hello made as the browser makes one: body from the inputs, WebCrypto's
  // raw signature converted, record assembled and verified. Same bytes as
  // Rust, then read back as a hello.
  for (const v of vectors.made_hellos) {
    const signer = unhex(v.signer);
    const body = core.helloBody(v.environment, signer, unhex(v.random), v.clock);
    check(hex(body) === v.body, `made ${v.name}: body`);
    const record = core.assemble(body, core.signatureFromRaw(unhex(v.raw_signature)));
    check(hex(record) === v.record, `made ${v.name}: record`);
    check(core.verify(record), `made ${v.name}: verifies`);
    check(hex(core.introducedKey(record) ?? []) === v.signer, `made ${v.name}: introduces its signer`);
    check(hex(core.signer(record)) === v.signer, `made ${v.name}: signer`);
    for (const getter of ["matchId", "sides", "terms", "repeatsPlayer", "creator", "extraPlayerId"]) {
      check(core[getter](record) === null, `made ${v.name}: ${getter} is null`);
    }
    checks += 11;
  }
  // A hello cannot be made from a malformed key or a random value of the
  // wrong length. A bad key fails as it does everywhere else a key is taken
  // (accountId), with the same reason.
  const reason = (run) => {
    try { run(); } catch (error) { return error instanceof Damaged ? "Damaged" : error.message.replace(/^\w+: /, ""); }
    return null;
  };
  for (const v of vectors.invalid_hello_inputs) {
    const got = reason(() => core.helloBody(v.environment, unhex(v.signer), unhex(v.random)));
    const expected = v.name.startsWith("signer-")
      ? reason(() => core.accountId(unhex(v.signer)))
      : "the random value is 8 bytes";
    check(got !== null && got === expected, `invalid hello input ${v.name}: refused with ${got}, expected ${expected}`);
    checks += 1;
  }
  for (const [what, environment, clock] of [["environment", -1, null], ["environment", 2.5, null], ["clock", 2, -1], ["clock", 2, 2 ** 53]]) {
    const v = vectors.made_hellos[0];
    const got = reason(() => core.helloBody(environment, unhex(v.signer), unhex(v.random), clock));
    check(got?.startsWith(`${what} `), `helloBody ${what} ${environment} ${clock}: refused with ${got}`);
    checks += 1;
  }
  // assemble refuses a body whose signature does not verify.
  for (const v of vectors.unverifiable_records) {
    const record = unhex(v.record);
    const got = reason(() => core.assemble(core.body(record), core.signature(record)));
    check(got !== null && got !== "Damaged", `assemble unverifiable ${v.name}: refused`);
    checks += 1;
  }

  // ---- Making a `player`, a `match` and a `score`, and reading a score ----
  //
  // The made records are signed by the Rust tests' software keys: the vectors
  // hold each body's raw signature, as WebCrypto would give it.
  {
    const SCORE_GETTERS = ["scoredMatch", "slot", "value", "replaces"];
    const hexed = (value) =>
      value instanceof Uint8Array ? hex(value) : Array.isArray(value) ? value.map(hexed) : value;
    const same = (got, expected) => isDeepStrictEqual(hexed(got), expected);
    // The body a made record's vector describes, with any input replaced.
    const bodyOf = (v, replaced = {}) => {
      const i = { ...v, ...replaced };
      const [signer, random] = [unhex(i.signer), unhex(i.random)];
      if (i.kind_name === "player") return core.playerBody(i.environment, signer, random, i.clock);
      if (i.kind_name === "match") {
        const sides = i.sides.map((side) => side.map(unhex));
        return core.matchBody(i.environment, signer, random, sides, unhex(i.terms), i.clock);
      }
      return core.scoreBody(
        i.environment, signer, random, unhex(i.scored_match), i.slot, unhex(i.value), i.replaces.map(unhex), i.clock,
      );
    };
    const vector = Object.fromEntries(vectors.made_records.map((v) => [v.name, v]));

    // B1. Each body, signed and assembled, verifies and is of its kind. Same
    // bytes as Rust.
    const made = {};
    for (const v of vectors.made_records) {
      const body = bodyOf(v);
      check(hex(body) === v.body, `made ${v.name}: body`);
      const record = core.assemble(body, core.signatureFromRaw(unhex(v.raw_signature)));
      check(hex(record) === v.record, `made ${v.name}: record`);
      check(core.verify(record), `made ${v.name}: verifies`);
      check(core.kind(record) === v.kind_name, `made ${v.name}: kind is ${core.kind(record)}`);
      made[v.name] = record;
      checks += 4;
    }
    // The clock is optional, as helloBody's is.
    check(hex(bodyOf(vector.player, { clock: undefined })) === vector.player.body, "made player: no clock given");
    // kind names every record's kind, and gives null for a number the design
    // does not name.
    for (const v of vectors.records) {
      check(core.kind(unhex(v.record)) === v.kind_name, `${v.name}: kind is ${core.kind(unhex(v.record))}`);
      checks += 1;
    }
    check(vectors.records.some((v) => v.kind_name === null), "kind: a vector has an unknown kind");
    checks += 2;

    // B2. A made match gives back its sides and terms through the existing
    // getters, and a made player's extra player can be a side.
    {
      const v = vector.match;
      check(same(core.sides(made.match), v.sides), "made match: sides");
      check(same(core.terms(made.match), v.terms), "made match: terms");
      check(same(core.matchId(made.match), v.id), "made match: its id is the record id");
      const sides = core.sides(made.match).flat().map(hex);
      for (const name of ["player", "player-with-clock"]) {
        const extra = core.extraPlayerId(made[name]);
        check(extra !== null && sides.includes(hex(extra)), `made match: ${name}'s extra player is a side`);
      }
      check(
        hex(core.extraPlayerId(made.player)) !== hex(core.extraPlayerId(made["player-with-clock"])),
        "made players: two random values, two players",
      );
      checks += 6;
    }

    // B3. A made score gives back its match, slot, value and replaced ids;
    // those getters give nothing for another kind.
    for (const v of vectors.made_records.filter((v) => v.kind_name === "score")) {
      const record = made[v.name];
      check(same(core.scoredMatch(record), v.scored_match), `made ${v.name}: scoredMatch`);
      check(same(core.scoredMatch(record), hexed(core.matchId(made.match))), `made ${v.name}: is about the made match`);
      check(core.slot(record) === v.slot, `made ${v.name}: slot`);
      check(same(core.value(record), v.value), `made ${v.name}: value`);
      check(same(core.replaces(record), v.replaces), `made ${v.name}: replaces`);
      check(core.matchId(record) === null, `made ${v.name}: is not a match`);
      checks += 6;
    }
    check(same(core.replaces(made["score-replacing"]), [hex(core.id(made.score))]), "made score-replacing: replaces the made score");
    checks += 1;
    const others = [
      ...vectors.made_records.filter((v) => v.kind_name !== "score").map((v) => [`made ${v.name}`, made[v.name]]),
      ...vectors.made_hellos.map((v) => [`made ${v.name}`, unhex(v.record)]),
    ];
    for (const [name, record] of others) {
      for (const getter of SCORE_GETTERS) {
        check(core[getter](record) === null, `${name}: ${getter} is null`);
        checks += 1;
      }
    }
    // The same over every record vector: its value, or null when it has none.
    for (const v of vectors.records) {
      for (const [getter, field] of [["scoredMatch", "scored_match"], ["slot", "slot"], ["value", "value"], ["replaces", "replaces"]]) {
        const got = core[getter](unhex(v.record));
        check(same(got, v[field] ?? null), `${v.name}: ${getter} gave ${shown(hexed(got))}`);
        checks += 1;
      }
    }

    // B5. A key or a random value of the wrong length throws, with the reason
    // helloBody gives.
    for (const bad of vectors.invalid_hello_inputs) {
      const expected = reason(() => core.helloBody(bad.environment, unhex(bad.signer), unhex(bad.random)));
      for (const name of ["player", "match", "score"]) {
        const got = reason(() => bodyOf(vector[name], { signer: bad.signer, random: bad.random }));
        check(got !== null && got === expected, `invalid ${name} input ${bad.name}: refused with ${got}, expected ${expected}`);
        checks += 1;
      }
    }
    // The other inputs are checked too: ids are 32 bytes, a match has two
    // sides with a player each, and the numbers are whole numbers from 0.
    const id = "00".repeat(32);
    for (const [what, name, replaced] of [
      ["a player id of 31 bytes", "match", { sides: [[id.slice(2)], [id]] }],
      ["a player id of 33 bytes", "match", { sides: [[id], [id, `${id}00`]] }],
      ["two ids run together", "match", { sides: [[id + id], [id]] }],
      ["an empty side", "match", { sides: [[id], []] }],
      ["one side", "match", { sides: [[id]] }],
      ["three sides", "match", { sides: [[id], [id], [id]] }],
      ["a match id of 31 bytes", "score", { scored_match: id.slice(2) }],
      ["a replaced id of 33 bytes", "score", { replaces: [`${id}00`] }],
      ["a slot below 0", "score", { slot: -1 }],
      ["a slot that is not whole", "score", { slot: 1.5 }],
      ["an environment below 0", "player", { environment: -1 }],
      ["a clock past 2^53", "score", { clock: 2 ** 53 }],
    ]) {
      const got = reason(() => bodyOf(vector[name], replaced));
      check(got !== null && got !== "Damaged", `${name} body with ${what}: refused with ${got}`);
      checks += 1;
    }
  }

  for (const v of vectors.parcels) {
    for (const form of ["text", "link"]) {
      const binary = core.parse(v[form]);
      check(hex(binary) === v.binary, `parcel ${v.name} (${form}): binary`);
      check(core.text(binary) === v.text, `parcel ${v.name} (${form}): text`);
      const records = core.records(binary).map(hex);
      check(isDeepStrictEqual(records, v.records), `parcel ${v.name}: records`);
      checks += 3;
    }
    const rebuilt = core.build(v.environment, v.records.map(unhex));
    check(hex(rebuilt) === v.binary, `parcel ${v.name}: built from its records`);
    checks += 1;
    // The smallest limit, doubling from 400, that the parcel can be split to.
    let limit = 400;
    let parts;
    for (;;) {
      try { parts = core.split(unhex(v.binary), limit); break; } catch { limit *= 2; }
    }
    const seen = new Set(parts.flatMap((part) => core.records(part).map(hex)));
    check(v.records.every((r) => seen.has(r)), `parcel ${v.name}: split keeps every record`);
    check(parts.every((part) => core.text(part).length <= limit), `parcel ${v.name}: split sizes`);
    checks += 2;
  }
  const byName = Object.fromEntries(vectors.parcels.map((p) => [p.name, p]));
  for (const v of vectors.harmless_parcel_texts) {
    check(hex(core.parse(v.text)) === byName[v.parcel].binary, `harmless ${v.name}`);
    checks += 1;
  }
  for (const v of vectors.damaged_parcel_texts) {
    let damaged = false;
    try { core.parse(v.text); } catch (error) { damaged = error instanceof Damaged; }
    check(damaged, `damaged ${v.name}: refused as Damaged`);
    checks += 1;
  }
  for (const v of vectors.signatures) {
    if (v.der) check(hex(core.signatureFromDer(unhex(v.der))) === v.stored, `signature der ${v.key}`);
    check(hex(core.signatureFromRaw(unhex(v.raw))) === v.stored, `signature raw ${v.key}`);
    checks += 2;
  }
  for (const v of vectors.invalid_der) {
    let refused = false;
    try { core.signatureFromDer(unhex(v.der)); } catch { refused = true; }
    check(refused, `invalid der ${v.name}`);
    checks += 1;
  }
  // The product layouts: each value gives the vector's bytes and reads back
  // from them; bytes of another version or damaged read as null.
  for (const v of vectors.terms) {
    const what = `terms best of ${v.best_of} rated ${v.rated}`;
    check(hex(core.termsBytes(v.best_of, v.rated)) === v.bytes, `${what}: bytes`);
    const read = core.readTerms(unhex(v.bytes));
    check(isDeepStrictEqual(read, { bestOf: v.best_of, rated: v.rated }), `${what}: read ${shown(read)}`);
    checks += 2;
  }
  for (const v of vectors.unreadable_terms) {
    check(core.readTerms(unhex(v.bytes)) === null, `unreadable terms ${v.name}: null`);
    checks += 1;
  }
  for (const [bestOf, rated] of [...vectors.invalid_best_ofs.map((n) => [n, false]), [-1, false], [2.5, true], [2 ** 32 + 1, true], ["5", true], [5, 1], [5, undefined]]) {
    let refused = false;
    try { core.termsBytes(bestOf, rated); } catch (error) { refused = !(error instanceof Damaged); }
    check(refused, `termsBytes ${bestOf} ${rated}: refused`);
    checks += 1;
  }
  for (const v of vectors.score_values) {
    const what = `score value ${JSON.stringify(v.score)}`;
    check(hex(core.scoreValue(v.score)) === v.bytes, `${what}: bytes`);
    const read = core.readScoreValue(unhex(v.bytes));
    check(isDeepStrictEqual(read, { score: v.score }), `${what}: read ${shown(read)}`);
    checks += 2;
  }
  for (const v of vectors.unreadable_score_values) {
    check(core.readScoreValue(unhex(v.bytes)) === null, `unreadable score value ${v.name}: null`);
    checks += 1;
  }
  for (const score of [undefined, [11], [11, 9, 7], [-1, 0], [11, 2.5], [2 ** 32, 0], ["11", 9], 11]) {
    let refused = false;
    try { core.scoreValue(score); } catch (error) { refused = !(error instanceof Damaged); }
    check(refused, `scoreValue ${JSON.stringify(score)}: refused`);
    checks += 1;
  }
  // A match's state from each set of records, as Rust gives it: a corrected
  // game (C2), a gap and a clear at the end (C3), the current ids (C4).
  {
    const hexed = (value) =>
      value instanceof Uint8Array ? hex(value) : Array.isArray(value) ? value.map(hexed) : value;
    for (const v of vectors.match_states) {
      const state = core.matchState(v.records.map(unhex));
      const got = state && {
        match_id: hex(state.matchId),
        creator: hex(state.creator),
        sides: hexed(state.sides),
        terms: state.terms && { best_of: state.terms.bestOf, rated: state.terms.rated },
        games: state.games,
        current: hexed(state.current),
      };
      check(state !== null, `match state ${v.name}: a state`);
      for (const field of ["match_id", "creator", "sides", "terms", "games", "current"]) {
        // Strict: a gap in games must be null, not undefined.
        check(isDeepStrictEqual(got?.[field], v.state[field]), `match state ${v.name}: ${field} gave ${shown(got?.[field])}`);
      }
      checks += 7;
    }
    // No match record, no state; bytes that are not a record throw.
    const match = vectors.match_states[0];
    const scores = match.records.filter((r) => core.kind(unhex(r)) === "score").map(unhex);
    check(core.matchState(scores) === null, "match state without a match record: null");
    check(core.matchState([]) === null, "match state of no records: null");
    let refused = false;
    try { core.matchState([new Uint8Array([1, 2, 3])]); } catch (error) { refused = !(error instanceof Damaged); }
    check(refused, "match state of bytes that are not a record: throws");
    checks += 3;
  }
  console.log(`  ${checks} checks`);
}

if (failures > 0) {
  console.error(`${failures} checks failed`);
  process.exit(1);
}
console.log("all golden vectors pass");
