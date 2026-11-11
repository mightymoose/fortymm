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
  // Making a match record the way a browser does: a non-extractable WebCrypto
  // key, its raw public key converted by the core, the body built by the
  // core, signed by WebCrypto, and the record assembled by the core.
  {
    const subtle = globalThis.crypto.subtle;
    const keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const raw = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
    const signer = core.publicKeyFromRaw(raw);
    check(signer.length === 33 && hex(signer.slice(1)) === hex(raw.slice(1, 33)), "made: signer is X with Y's parity");
    check(signer[0] === 2 + (raw[64] & 1), "made: signer prefix");
    const players = [new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22)];
    const random = globalThis.crypto.getRandomValues(new Uint8Array(8));
    const body = core.matchBody(3, signer, random, [[players[0]], [players[1]]], new Uint8Array([7]));
    const signature = core.signatureFromRaw(new Uint8Array(
      await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, body)));
    const record = core.recordFromParts(body, signature);
    check(hex(core.body(record)) === hex(body), "made: body");
    check(hex(core.signer(record)) === hex(signer), "made: signer in the body");
    check(await core.verify(record), "made: verifies");
    const parcel = core.parse(core.text(core.build(3, [record])));
    check(JSON.stringify(core.records(parcel).map(hex)) === JSON.stringify([hex(record)]), "made: parcel round trip");
    for (const [what, make] of [
      ["an empty side", () => core.matchBody(3, signer, random, [[], [players[1]]], new Uint8Array())],
      ["a compressed key as raw", () => core.publicKeyFromRaw(signer)],
      ["a body over the size limit", () => core.matchBody(3, signer, random, [[players[0]], [players[1]]], new Uint8Array(5000))],
    ]) {
      let refused = false;
      try { make(); } catch (error) { refused = !(error instanceof Damaged) && error.message.startsWith("fmm_"); }
      check(refused, `made: refuses ${what}`);
    }
    checks += 11;
  }
  console.log(`  ${checks} checks`);
}

if (failures > 0) {
  console.error(`${failures} checks failed`);
  process.exit(1);
}
console.log("all golden vectors pass");
