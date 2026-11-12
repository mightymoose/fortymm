// The small hand-written wrapper over the core's WebAssembly interface
// (design section 14). It copies bytes in and out of the module's memory and
// turns status codes into exceptions. The module hashes and verifies by
// itself, so every method is synchronous except `load`; only signing, which
// the core never does, uses the browser's WebCrypto.

const OK = 0;
const NOT_APPLICABLE = 2;
const DAMAGED = 3;
const BAD_SIGNATURE = 4;

export class Damaged extends Error {}

export class Core {
  static async load(wasmBytes) {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    return new Core(instance.exports);
  }

  constructor(exports) {
    this.x = exports;
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

  id(record) { return this.call("fmm_record_id", record).out; }
  verify(record) { return this.call("fmm_record_verify", record).status === OK; }
  outcomeId(record) {
    const { status, out } = this.call("fmm_record_outcome_id", record, { allow: [NOT_APPLICABLE] });
    return status === OK ? out : null;
  }

  // Keys: the 33 bytes a record stores.
  accountId(publicKey) { return this.call("fmm_account_id", publicKey).out; }
  ownPlayerId(publicKey) { return this.call("fmm_own_player_id", publicKey).out; }

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
