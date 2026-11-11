// The small hand-written wrapper over the core's WebAssembly interface
// (design section 14). It copies bytes in and out of the module's memory and
// turns status codes into exceptions.
//
// With a module built without cryptography, hashing and signature
// verification use WebCrypto, which is asynchronous, so `id`, `verify`,
// `outcomeId`, `accountId` and `ownPlayerId` return promises in both builds.

const OK = 0;
const NOT_APPLICABLE = 2;
const DAMAGED = 3;
const BAD_SIGNATURE = 4;

export class Damaged extends Error {}

export class Core {
  static async load(wasmBytes, { subtle = globalThis.crypto?.subtle } = {}) {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    return new Core(instance.exports, subtle);
  }

  constructor(exports, subtle) {
    this.x = exports;
    this.subtle = subtle;
    // A module built without cryptography exports no fmm_record_id.
    this.hasCrypto = typeof exports.fmm_record_id === "function";
  }

  call(name, input, { allow = [] } = {}) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const pointer = this.x.fmm_alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, pointer, bytes.length).set(bytes);
    const status = this.x[name](pointer, bytes.length);
    this.x.fmm_free(pointer, bytes.length);
    const out = new Uint8Array(this.x.memory.buffer, this.x.fmm_out_ptr(), this.x.fmm_out_len()).slice();
    if (status === OK || allow.includes(status)) return { status, out };
    const reason = new TextDecoder().decode(out);
    if (status === DAMAGED) throw new Damaged(reason);
    if (status === BAD_SIGNATURE) return { status, out };
    throw new Error(`${name}: ${reason}`);
  }

  // Records.
  decodeRecord(record) { return this.call("fmm_record_decode", record).out; }
  body(record) { return this.call("fmm_record_body", record).out; }
  signature(record) { return this.call("fmm_record_signature", record).out; }
  signer(record) { return this.call("fmm_record_signer", record).out; }

  async sha256(bytes) {
    return new Uint8Array(await this.subtle.digest("SHA-256", bytes));
  }

  async id(record) {
    if (this.hasCrypto) return this.call("fmm_record_id", record).out;
    return this.sha256(this.body(record));
  }

  async verify(record) {
    if (this.hasCrypto) return this.call("fmm_record_verify", record).status === OK;
    // WebCrypto verifies the raw r||s form, which is the stored form.
    const key = await this.subtle.importKey(
      "raw", this.signer(record), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return this.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, this.signature(record), this.body(record));
  }

  async outcomeId(record) {
    if (this.hasCrypto) {
      const { status, out } = this.call("fmm_record_outcome_id", record, { allow: [NOT_APPLICABLE] });
      return status === OK ? out : null;
    }
    const { status, out } = this.call("fmm_record_outcome_preimage", record, { allow: [NOT_APPLICABLE] });
    return status === OK ? this.sha256(out) : null;
  }

  async accountId(publicKey) {
    return this.sha256(this.call("fmm_account_id_preimage", publicKey).out);
  }

  async ownPlayerId(publicKey) {
    return this.sha256(this.call("fmm_own_player_id_preimage", publicKey).out);
  }

  // Making a record. The core builds the body and assembles the record; the
  // caller signs the body (the core never signs) and supplies the random
  // value (the core has no random generator).

  // WebCrypto's "raw" export of a P-256 public key (65 bytes, uncompressed)
  // to the 33-byte form a record stores.
  publicKeyFromRaw(raw) { return this.call("fmm_public_key_from_raw", raw).out; }

  // The body of a `match` record to sign. `sides` is two non-empty arrays of
  // 32-byte player ids; `terms` is opaque bytes; `random` is 8 bytes.
  matchBody(environment, signer, random, sides, terms) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setBigUint64(0, BigInt(environment));
    const parts = [head, signer, random];
    for (const side of sides) {
      const count = new Uint8Array(4);
      new DataView(count.buffer).setUint32(0, side.length);
      parts.push(count, ...side);
    }
    parts.push(terms);
    return this.call("fmm_match_body", concat(parts)).out;
  }

  // A standalone record from a body and its stored 64-byte signature.
  recordFromParts(body, signature) {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, body.length);
    return this.call("fmm_record_from_parts", concat([size, body, signature])).out;
  }

  // Signatures.
  signatureFromDer(der) { return this.call("fmm_signature_from_der", der).out; }
  signatureFromRaw(raw) { return this.call("fmm_signature_from_raw", raw).out; }

  // Parcels. A parcel is handled as its binary form.
  parse(text) { return this.call("fmm_parcel_parse", text).out; }
  text(binary) { return new TextDecoder().decode(this.call("fmm_parcel_text", binary).out); }
  records(binary) { return unframe(this.call("fmm_parcel_records", binary).out); }
  build(environment, records) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setBigUint64(0, BigInt(environment));
    return this.call("fmm_parcel_build", concat([head, frame(records)])).out;
  }
  split(binary, maxChars) {
    if (!this.hasCrypto) throw new Error("split needs record ids: use the build with cryptography");
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, maxChars);
    return unframe(this.call("fmm_parcel_split", concat([head, binary])).out);
  }
}

function frame(items) {
  return concat(items.flatMap((item) => {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, item.length);
    return [size, item];
  }));
}

function unframe(bytes) {
  const items = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length;) {
    const size = view.getUint32(at);
    items.push(bytes.slice(at + 4, at + 4 + size));
    at += 4 + size;
  }
  return items;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
