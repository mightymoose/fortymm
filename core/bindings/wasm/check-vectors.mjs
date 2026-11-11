// Run the golden vectors through a WebAssembly build of the core, from Node.
//
//   node check-vectors.mjs <vectors.json> <module.wasm> [<module.wasm> ...]
//
// Each module is checked in full. A module built without cryptography is
// checked with WebCrypto (Node's implementation) doing the hashing and the
// verification, as a browser would.

import { readFile } from "node:fs/promises";
import { Core, Damaged } from "./fortymm-core.mjs";

const [vectorsPath, ...modules] = process.argv.slice(2);
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

for (const path of modules) {
  const wasm = await readFile(path);
  const core = await Core.load(wasm);
  const label = core.hasCrypto ? "with cryptography" : "without cryptography (WebCrypto)";
  console.log(`${path}: ${wasm.length} bytes, ${label}`);
  let checks = 0;

  for (const v of vectors.records) {
    const record = unhex(v.record);
    check(hex(core.decodeRecord(record)) === v.record, `${v.name}: re-encodes`);
    check(hex(core.body(record)) === v.body, `${v.name}: body`);
    check(hex(await core.id(record)) === v.id, `${v.name}: id`);
    check(await core.verify(record), `${v.name}: verifies`);
    const signer = unhex(v.signer);
    check(hex(await core.accountId(signer)) === v.signer_account_id, `${v.name}: account id`);
    check(hex(await core.ownPlayerId(signer)) === v.signer_own_player_id, `${v.name}: own player id`);
    const outcome = await core.outcomeId(record);
    check((outcome && hex(outcome)) === (v.outcome_id ?? null), `${v.name}: outcome id`);
    checks += 7;
  }
  for (const v of vectors.invalid_records) {
    let refused = false;
    try { core.decodeRecord(unhex(v.record)); } catch { refused = true; }
    check(refused, `invalid ${v.name}: refused`);
    checks += 1;
  }
  for (const v of vectors.unverifiable_records) {
    check(!(await core.verify(unhex(v.record))), `unverifiable ${v.name}: does not verify`);
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
    if (core.hasCrypto) {
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
