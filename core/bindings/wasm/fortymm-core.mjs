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

  // What a record says about its match and its players. Each reports what
  // the bytes say, not that the record counts: `verify` is a separate call.
  // A record of another kind, or one this library did not interpret (an
  // unknown kind, or a format version it cannot read), gives null; every
  // record still has its signer.
  optional(name, record) {
    const { status, out } = this.call(name, record, { allow: [NOT_APPLICABLE] });
    return status === OK ? out : null;
  }
  matchId(record) { return this.optional("fmm_record_match_id", record); }
  sides(record) {
    const out = this.optional("fmm_record_sides", record);
    if (out === null) return null;
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const sides = [];
    for (let at = 0; sides.length < 2;) {
      const count = view.getUint32(at);
      at += 4;
      const side = [];
      for (let i = 0; i < count; i += 1, at += 32) side.push(out.slice(at, at + 32));
      sides.push(side);
    }
    return sides;
  }
  terms(record) { return this.optional("fmm_record_terms", record); }
  repeatsPlayer(record) {
    const out = this.optional("fmm_record_repeats_player", record);
    return out === null ? null : out[0] === 1;
  }
  creator(record) { return this.optional("fmm_record_creator", record); }
  extraPlayerId(record) { return this.optional("fmm_record_extra_player_id", record); }
  introducedKey(record) { return this.optional("fmm_record_introduced_key", record); }
  signerAccountId(record) { return this.accountId(this.signer(record)); }
  signerOwnPlayerId(record) { return this.ownPlayerId(this.signer(record)); }

  // Making a record (design section 4.4): the core builds the body, the
  // platform signs it with its own key (WebCrypto: ECDSA P-256 with SHA-256,
  // which gives raw r||s; convert it with `signatureFromRaw`), and `assemble`
  // puts the record together and verifies it.
  //
  // The body of a `hello` introducing `publicKey` (33 bytes, compressed),
  // with the 8-byte `random` value from the platform's random generator and,
  // optionally, the device clock in milliseconds since the Unix epoch.
  helloBody(environment, publicKey, random, clock = null) {
    const head = new Uint8Array(17);
    const view = new DataView(head.buffer);
    view.setBigUint64(0, uint64(environment, "helloBody: environment"));
    if (clock !== null) {
      view.setUint8(8, 1);
      view.setBigUint64(9, uint64(clock, "helloBody: clock"));
    }
    return this.call("fmm_hello_body", concat([head, frame([publicKey, random])])).out;
  }
  // The standalone record from a body and its stored 64-byte signature.
  // Throws if the body is not valid or the signature does not verify.
  assemble(body, signature) {
    const { status, out } = this.call("fmm_record_assemble", frame([body, signature]));
    if (status === BAD_SIGNATURE) throw new Error(`assemble: ${new TextDecoder().decode(out)}`);
    return out;
  }

  // Keys: the 33 bytes a record stores.
  accountId(publicKey) { return this.call("fmm_account_id", publicKey).out; }
  ownPlayerId(publicKey) { return this.call("fmm_own_player_id", publicKey).out; }

  // The generated username of a 32-byte player id, with a suffix of
  // `suffixLength` characters (4 to 16). Throws for any other length.
  username(playerId, suffixLength) {
    if (!Number.isInteger(suffixLength) || suffixLength < 0 || suffixLength > 0xffffffff) {
      throw new Error(`username: suffix length ${suffixLength} is not a whole number`);
    }
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, suffixLength);
    return new TextDecoder().decode(this.call("fmm_username", concat([head, playerId])).out);
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
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, maxChars);
    return unframe(this.call("fmm_parcel_split", concat([head, binary])).out);
  }
}

function uint64(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} ${value} is not a whole number from 0`);
  }
  return BigInt(value);
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
