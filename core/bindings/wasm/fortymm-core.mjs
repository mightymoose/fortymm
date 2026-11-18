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

  // ---- Making a `player`, a `match` and a `score`, and reading a score ----
  //
  // Each body is made as a hello's is: sign it, then `assemble`. Every one
  // takes the environment, the signer's key (33 bytes, compressed), the
  // 8-byte `random` value and, last and optional, the clock. A key or a
  // random value of the wrong length throws, as in `helloBody`; so does an
  // id that is not 32 bytes.
  //
  // The body of a `player`: a new extra player, created by the signer. Its
  // id is the record's (`extraPlayerId`), so each random value is one player.
  playerBody(environment, publicKey, random, clock = null) {
    const head = bodyHead("playerBody", environment, clock);
    return this.call("fmm_player_body", concat([head, frame([publicKey, random])])).out;
  }
  // The body of a `match` between two sides, each a list of 32-byte player
  // ids, on `terms` (bytes the core carries). One side may be empty, an
  // anonymous side, never both; a match with an anonymous side can't be
  // rated, so terms that read as rated throw.
  matchBody(environment, publicKey, random, sides, terms, clock = null) {
    const head = bodyHead("matchBody", environment, clock);
    const items = [publicKey, random, terms, ...sides.map(frame)];
    return this.call("fmm_match_body", concat([head, frame(items)])).out;
  }
  // The body of a `score` about the match `matchId` (32 bytes): `slot` is n
  // for game n (0 is accepted but means no game), `value` is bytes the core carries
  // and does not read, and `replaces` lists the ids of the `score` records
  // this one replaces.
  scoreBody(environment, publicKey, random, matchId, slot, value, replaces, clock = null) {
    const head = bodyHead("scoreBody", environment, clock);
    const slotBytes = new Uint8Array(8);
    new DataView(slotBytes.buffer).setBigUint64(0, uint64(slot, "scoreBody: slot"));
    const items = [publicKey, random, matchId, slotBytes, value, frame(replaces)];
    return this.call("fmm_score_body", concat([head, frame(items)])).out;
  }

  // The record's kind by name ("hello", "player", "match", "score", ...), or
  // null for a kind number the design does not name. A named kind is not
  // always one this library read the fields of.
  kind(record) {
    const out = this.optional("fmm_record_kind", record);
    return out === null ? null : new TextDecoder().decode(out);
  }
  // What a `score` record says; null for a record of any other kind.
  // `scoredMatch` is the match the score is about (`matchId` is a `match`
  // record's own id). A slot past 2^53 - 1 comes back rounded.
  scoredMatch(record) { return this.optional("fmm_record_scored_match", record); }
  slot(record) {
    const out = this.optional("fmm_record_slot", record);
    return out === null ? null : Number(new DataView(out.buffer).getBigUint64(0));
  }
  value(record) { return this.optional("fmm_record_value", record); }
  replaces(record) {
    const out = this.optional("fmm_record_replaces", record);
    if (out === null) return null;
    const ids = [];
    for (let at = 0; at < out.length; at += 32) ids.push(out.slice(at, at + 32));
    return ids;
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

  // The product layouts: the bytes a `match` record carries as its terms and
  // a `score` record as its value. Each layout has its own version. Reading
  // gives null for bytes of another version and for damaged bytes; it never
  // throws.
  //
  // The terms of a match that is best of `bestOf` games (an odd number, 1 or
  // more), rated or not. Throws for any other best of.
  termsBytes(bestOf, rated) {
    if (typeof rated !== "boolean") throw new Error(`termsBytes: rated ${rated} is not true or false`);
    const input = new Uint8Array(5);
    new DataView(input.buffer).setUint32(0, uint32(bestOf, "termsBytes: best of"));
    input[4] = rated ? 1 : 0;
    return this.call("fmm_terms_bytes", input).out;
  }
  readTerms(terms) {
    const out = this.optional("fmm_terms_read", terms);
    if (out === null) return null;
    return { bestOf: new DataView(out.buffer).getUint32(0), rated: out[4] === 1 };
  }
  // The value of a score: the two sides' points in the game, first side
  // first, or null for a cleared game.
  scoreValue(score) {
    if (score === null) return this.call("fmm_score_value", new Uint8Array([0])).out;
    if (!Array.isArray(score) || score.length !== 2) {
      throw new Error("scoreValue: a score is two sides' points, or null");
    }
    const input = new Uint8Array(9);
    const view = new DataView(input.buffer);
    input[0] = 1;
    view.setUint32(1, uint32(score[0], "scoreValue: points"));
    view.setUint32(5, uint32(score[1], "scoreValue: points"));
    return this.call("fmm_score_value", input).out;
  }
  readScoreValue(value) {
    const out = this.optional("fmm_score_value_read", value);
    if (out === null) return null;
    if (out[0] === 0) return { score: null };
    const view = new DataView(out.buffer);
    return { score: [view.getUint32(1), view.getUint32(5)] };
  }

  // A match's state, derived from the set of records the device holds about
  // it (core/FORMAT.md, section 16): any order, repeats allowed. Score
  // records of other matches, and records of other kinds, are ignored. Null
  // when the set holds no match record, or a match record of another match
  // too: pass only this match's records. Bytes that are not a record throw.
  matchState(records) {
    const { status, out } = this.call("fmm_match_state", frame(records), { allow: [NOT_APPLICABLE] });
    if (status !== OK) return null;
    const [matchId, creator, first, second, terms, games, current] = unframe(out);
    const pair = (bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return [view.getUint32(0), view.getUint32(4)];
    };
    return {
      matchId,
      creator,
      sides: [unframe(first), unframe(second)],
      terms: terms.length === 0
        ? null
        : { bestOf: new DataView(terms.buffer, terms.byteOffset).getUint32(0), rated: terms[4] === 1 },
      games: unframe(games).map((game) => (game.length === 0 ? null : pair(game))),
      current: unframe(current).map(unframe),
    };
  }
}

function uint32(value, what) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${what} ${value} is not a whole number from 0 to 4294967295`);
  }
  return value;
}

function uint64(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} ${value} is not a whole number from 0`);
  }
  return BigInt(value);
}

// What every body's input starts with: the environment, whether there is a
// clock reading, and the reading.
function bodyHead(method, environment, clock) {
  const head = new Uint8Array(17);
  const view = new DataView(head.buffer);
  view.setBigUint64(0, uint64(environment, `${method}: environment`));
  if (clock !== null) {
    view.setUint8(8, 1);
    view.setBigUint64(9, uint64(clock, `${method}: clock`));
  }
  return head;
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
