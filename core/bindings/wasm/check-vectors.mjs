// Run the golden vectors through a WebAssembly build of the core, from Node.
//
//   node check-vectors.mjs <vectors.json> <module.wasm>
//
// WebCrypto is hidden throughout: the module hashes and verifies by itself.

import { readFile } from "node:fs/promises";
import { Core, Damaged } from "./fortymm-core.mjs";

const [vectorsPath, path] = process.argv.slice(2);
const vectors = JSON.parse(await readFile(vectorsPath, "utf8"));

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const unhex = (text) => new Uint8Array(Buffer.from(text, "hex"));

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
      const got = JSON.stringify(hexed(core[getter](record)));
      check(got === JSON.stringify(v[field] ?? null), `${v.name}: ${getter} gave ${got}`);
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
  for (const v of vectors.parcels) {
    for (const form of ["text", "link"]) {
      const binary = core.parse(v[form]);
      check(hex(binary) === v.binary, `parcel ${v.name} (${form}): binary`);
      check(core.text(binary) === v.text, `parcel ${v.name} (${form}): text`);
      const records = core.records(binary).map(hex);
      check(JSON.stringify(records) === JSON.stringify(v.records), `parcel ${v.name}: records`);
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
  console.log(`  ${checks} checks`);
}

if (failures > 0) {
  console.error(`${failures} checks failed`);
  process.exit(1);
}
console.log("all golden vectors pass");
