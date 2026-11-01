# Signed result format v1

A signed result is a match result that each player's device signed. It is the
only form in which a result reaches the FortyMM server, by QR code between
phones or by link. This document specifies the format. `vectors.json` beside
it holds the test vectors that the API's, the web client's and the iOS app's
test suites check, so a client whose encoding drifts fails its own suite.

The format uses these standards:

| Standard | Used for |
| --- | --- |
| CBOR, RFC 8949, with the core deterministic encoding of section 4.2.1 | Every encoded item. |
| COSE_Sign, RFC 9052 section 4.1, with the ES256 algorithm (RFC 9053) | The envelope, one signature per signer. |
| CWT, RFC 8392 | The payload is a CWT claims set. |
| COSE_Key thumbprint, RFC 9679 | The key id each signature cites. |
| Base45, RFC 9285 | The QR text. |
| base64url, RFC 4648 section 5, without padding | The link. |

Deterministic CBOR means shortest integer forms, definite lengths, and map keys
sorted by the bytes of their encoding. Every map in this format has keys that
sort the same under the older length-first order of RFC 7049 section 3.9, so an
encoder that offers only that order, such as cbor2's `canonical=True`, writes
the same bytes.

The format fixes the shape and the types of a result. Whether the scores are a
legal ending (games to 11, win by 2, the majority reached) is not the format's
rule. The server checks it when it records the result.

## The payload

The payload is a CWT claims map with exactly two claims.

| Key | Name | Type | Meaning |
| --- | --- | --- | --- |
| `6` | iat | uint | Seconds since the Unix epoch when the payload was made. The server trusts nothing from it. |
| `"fortymm/match-result/v1"` | the domain tag | map | The result. The key is the domain tag, so a signature over this payload can't be mistaken for a signature over another CWT that the same key signs. A new version of the format is a new key. |

The result map:

| Key | Name | Type | Meaning |
| --- | --- | --- | --- |
| `1` | match | bstr(16) | The match id, the 16 bytes of a UUID. The client makes it, so a result can reach the server before its match. |
| `2` | best_of | 3, 5 or 7 | The format. |
| `3` | rated | bool | Whether the match counts for ratings. |
| `4` | players | [bstr(16), bstr(16)] | The two player ids. Distinct. Their order fixes the order of each game's points. |
| `5` | games | [[uint, uint], ...] | Each game's points, for players[0] then players[1], in the order played. 0 to best_of entries. A retirement can come before a game ends, so the last game may be unfinished. |
| `6` | ending | 0 or 1 | 0 completed, 1 retired. |
| `7` | retired_by | 0 or 1 | The side of the player who retired, as an index into players. Present exactly when ending is 1. |
| `8` | replaces | bstr(32) | For a correction, the hash of the result it replaces. Absent otherwise. |

No other keys. A UUID is always its 16 bytes in a byte string, never CBOR tag
37. A boolean is CBOR `true` or `false`, never 1 or 0. An integer is a CBOR
integer, never a float.

A payload names player ids as they were when it was signed. A player that a
merge later points at another player is still a valid payload. The server
resolves it through `merged_into`.

## The result's identity

The result's identity is the SHA-256 of the payload bytes, the bytes inside
the envelope's payload string. Two envelopes with the same payload bytes are
the same result, and the server merges their signatures. `replaces` holds
those 32 bytes. Elsewhere the hash is shown as lowercase hex.

## The envelope

The envelope is a COSE_Sign with CBOR tag 98, in deterministic CBOR.

```
98([
  h'',                      ; body protected header: a zero-length byte string
  {},                       ; body unprotected header: empty
  <payload bytes>,          ; the claims map, as a byte string
  [                         ; one COSE_Signature per signer, in no fixed order
    [<signer protected bytes>, {}, <64-byte signature>],
    ...
  ]
])
```

The body protected header is the zero-length byte string `h''`, not `h'a0'`,
an encoded empty map. Both unprotected headers are empty maps.

Each signer's protected header is deterministic CBOR with exactly these keys:

| Label | Type | Meaning |
| --- | --- | --- |
| `1` (alg) | `-7` | ES256. |
| `4` (kid) | bstr(32) | The signer's COSE_Key thumbprint. |
| `"player"` | 0 or 1 | The side this signature approves the result for, as an index into the payload's players. |

A key id is the RFC 9679 thumbprint: the SHA-256 of the deterministic CBOR of
the COSE_Key map `{1: 2, -1: 1, -2: x, -3: y}`, which is kty EC2, crv P-256,
and the coordinates as 32-byte strings. The map has no other parameter. The
encoded key is 75 bytes.

The signature is ECDSA P-256 with SHA-256 over the Sig_structure of RFC 9052
section 4.4, in deterministic CBOR:

```
["Signature", h'', <signer protected bytes>, h'', <payload bytes>]
```

The second element is the body protected header and the fourth is the external
data, both empty. The signature is the raw concatenation `r || s`, 64 bytes,
each integer as 32 bytes big-endian. A signer whose platform makes DER, such as
Android's Keystore, converts it to this form.

The second signer appends a COSE_Signature to the received array, over the
received payload bytes. It never decodes and re-encodes the payload, even
deterministically. A re-encoded payload is a different result, or breaks the
first signature.

Two signatures for one side pass the format, as do two sides signed by one key.
A player and their representative can both approve, and one account can
represent both players. The server decides what the signatures mean.

## The QR text and the link

The QR text is `FMR1:` followed by the Base45 of the envelope bytes. Every
character is in the QR alphanumeric set. The link is `https://fortymm.com/r#`
followed by the unpadded base64url of the envelope bytes. The fragment never
reaches a server log or a link preview.

Neither form compresses the envelope. The bytes are ids, hashes and
signatures, so zlib makes most vectors larger. It grows the `longest` vector
from 406 to 414 bytes, and it would cost every client an inflate step.

Measured on the `longest` vector (best of 7, every game past deuce, retired in
the last game, a correction, two signatures): the payload is 166 bytes, the
envelope 406 bytes, the QR text 614 characters and the link 564 characters.
That QR text fits QR version 16 at error correction level M, whose
alphanumeric capacity is 656 characters, and version 14 at level L, whose
capacity is 667. Render the QR code at level M. Level L also fits. A third
signature adds 116 bytes to the envelope and takes the QR text past version
16 at level M.

## What a verifier refuses

A verifier distinguishes three error classes:

| Class | Meaning |
| --- | --- |
| `malformed` | The bytes aren't this format. Decided from the bytes alone, with no key. |
| `unknown_key` | A signature's kid matches no key the verifier holds. |
| `bad_signature` | A signature doesn't verify with its key. |

The checks run in this order, and the first failure decides the class. Each
input has exactly one class.

1. Text. A QR text must start with `FMR1:` and hold strict Base45. A link must
   start with `https://fortymm.com/r#` and hold strict unpadded base64url.
   Strict means that the decoded bytes encode back to the same text. Any other
   prefix, a character outside the alphabet, a Base45 group whose value is too
   large, base64 padding, the standard base64 alphabet or nonzero spare bits is
   `malformed`.
2. Decode. The envelope, the payload and every signer header must be
   deterministic CBOR, with every map key and every integer of the exact type
   the tables give. A tag other than 98, a non-empty body header, an empty
   signature array, a payload with another claim or another result shape, a
   signer header with other labels, an alg other than -7, a side that isn't 0
   or 1, or a signature that isn't 64 bytes is `malformed`.
3. Keys. Every kid is resolved before any signature is checked. A kid with no
   key is `unknown_key`.
4. Signatures. The first COSE_Signature, in envelope order, that doesn't verify
   is `bad_signature`.

The precedence is part of the format. A `malformed` input gets that class from
every implementation, including a client that holds no keys. A repeated (kid,
side) signature counts once in what a verifier returns.

## Test vectors

`vectors.json` is the shared test data. `api/tests/signed_result_vectors.py`
writes it, run by `./bin/mise run api:signed-result-vectors`. Nobody edits it
by hand. The API's test `test_the_committed_vectors_are_fresh` fails when the
committed file differs from a fresh generation. Keys, ids and times are fixed
and ECDSA signing is deterministic (RFC 6979), so a regeneration writes the
same bytes. Once a client has shipped, a change to an existing vector's bytes
is a format change. New vectors go at the end of their list.

Conventions in the file: bytes are lowercase hex with no prefix. UUIDs are
lowercase and hyphenated. `issued_at` is integer seconds. The generator writes
`json.dumps(..., indent=2)` and a final newline, with the fields in the order
the tables give.

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | string | Always `"fortymm/match-result/v1"`. A suite checks it first. |
| `generated_by` | string | The generator and its task, for people. |
| `keys` | object, name to Key | The test keys. This is also the key directory. A verifier resolves every vector's kids against all of these keys and nothing else. |
| `valid` | array of Valid | Vectors that every implementation accepts. |
| `invalid` | array of Invalid | Vectors that every implementation refuses, each with one error class. |

### Key

| Field | Type | Meaning |
| --- | --- | --- |
| `d` | hex, 32 bytes | The private scalar, so a client can sign in its tests. It is `SHA-256("fortymm/match-result/v1 test key <name>")`. |
| `x`, `y` | hex, 32 bytes each | The public point, big-endian. |
| `cose_key` | hex, 75 bytes | The deterministic CBOR of `{1: 2, -1: 1, -2: x, -3: y}`. |
| `kid` | hex, 32 bytes | `SHA-256(cose_key)`, the thumbprint. |

The names are `ann` (player 0's device), `bo` (player 1's device) and `cy` (a
representative's device, which approves for either player). The `unknown-kid`
vector carries a signature by a fourth key that the file doesn't list.

### Valid

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Unique, kebab-case. The test's name. |
| `description` | string | What the vector shows. |
| `note` | string, optional | A warning for clients, such as "don't refuse this". |
| `issued_at` | integer | The payload's `iat`. |
| `result` | Result | The decoded result, in readable form. |
| `payload` | hex | The payload bytes. |
| `hash` | hex, 32 bytes | `SHA-256(payload)`. |
| `signatures` | array of Signature | The envelope's COSE_Signatures, in envelope order, with the steps behind each one. |
| `approvals` | array of `{kid, player}` | What a verifier returns. The set of (kid, player) pairs with repeats counted once, sorted by `player` then `kid`. Compare it as a set. |
| `envelope` | hex | The COSE_Sign envelope. |
| `qr` | string | The QR text. |
| `link` | string | The link. |

### Result

| Field | Type | On the wire |
| --- | --- | --- |
| `match` | UUID | `1`, bstr(16) |
| `best_of` | 3, 5 or 7 | `2`, uint |
| `rated` | boolean | `3`, `true` or `false` |
| `players` | [UUID, UUID] | `4`, [bstr(16), bstr(16)] |
| `games` | [[uint, uint], ...] | `5` |
| `ending` | `"completed"` or `"retired"` | `6`, 0 or 1 |
| `retired_by` | 0, 1 or null | `7`, present exactly when `ending` is `"retired"` |
| `replaces` | hex (32 bytes) or null | `8`, present exactly when not null |

### Signature

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | A name in `keys`. |
| `kid` | hex | That key's `kid`. |
| `side` | 0 or 1 | The `"player"` header, the side this signature approves for. |
| `player` | UUID | `result.players[side]`. |
| `protected` | hex | The signer's protected header, `{1: -7, 4: kid, "player": side}`. |
| `to_be_signed` | hex | The Sig_structure, `["Signature", h'', protected, h'', payload]`. The generator works it out separately from the API's codec and checks it against `signature` before it writes the file. |
| `signature` | hex, 64 bytes | ECDSA P-256 SHA-256 over `to_be_signed`, as raw `r || s`. It is deterministic (RFC 6979), so a deterministic signer gets these exact bytes. |

### Invalid

| Field | Type | Meaning |
| --- | --- | --- |
| `name`, `description` | string | As in Valid. |
| `error` | `"malformed"`, `"unknown_key"` or `"bad_signature"` | The class every implementation reports. |
| `envelope` | hex, optional | The bad envelope. |
| `text` | string, optional | A bad QR text or link. Exactly one of `envelope` and `text` is present. |

### Checks a client's suite runs

Signer checks are for every client, because every client signs. Verifier
checks are for any implementation that verifies: the API, and a client whose
tests verify.

Every key, signer:

- K1. The public key derived from `d` is (`x`, `y`). Import `d` as a software
  key in tests. A hardware key can't be imported.
- K2. The COSE_Key encoding of (`x`, `y`) equals `cose_key` byte for byte.
- K3. `SHA-256(cose_key)` equals `kid`.

Every valid vector, signer:

- V1. Encoding `issued_at` and `result` gives `payload` byte for byte. This is
  the drift check that matters most.
- V2. Decoding `payload` gives back `issued_at` and `result`, and
  `SHA-256(payload)` equals `hash`.
- V3. For each signature, the protected header built from (`kid`, `side`)
  equals `protected`, and the Sig_structure built from `protected` and
  `payload` equals `to_be_signed`.
- V4. Each `signature` verifies over `to_be_signed` with its key's (`x`, `y`).
  Then sign `to_be_signed` with the key's `d` through the platform's own
  signer, and check that the signature verifies. WebCrypto and CryptoKit use a
  random nonce, so compare by verifying, not by bytes. A platform that makes
  DER converts to raw `r || s` first.
- V5. Assembling an envelope from `payload` and the `signatures` (protected,
  signature) in order gives `envelope` byte for byte. Appending the last
  signature to the envelope made of the others gives the same bytes. That is
  the second signer's step, and it never re-encodes the payload.
- V6. The QR text of `envelope` equals `qr`, its link equals `link`, and
  reading `qr` and `link` back gives `envelope`.
- V7. `qr` uses only QR alphanumeric characters, and every vector with at most
  two signatures fits version 16 at level M.

Every valid vector, verifier:

- V8. Decoding and verifying `envelope` against the key directory gives
  `issued_at`, `result` and `hash`, and `approvals` as a set.

Every invalid vector:

- I1. Verifier. Reading `text` if present, decoding, then verifying against
  the key directory refuses with `error`, in the refusal order.
- I2. Signer, decode only. A `malformed` vector is refused at decode, so a
  client never shows or signs it. An `unknown_key` or `bad_signature` vector
  decodes, because it is well formed and only a verifier can refuse it. This
  catches a decoder that is too strict.

### The vectors

Valid:

| Name | What it pins |
| --- | --- |
| `completed-best-of-3` | Rated, completed, two signatures. |
| `completed-best-of-3-signatures-swapped` | The same payload with the signatures in the other order. Same `hash`, same `approvals`. |
| `half-signed` | One signature. This is what passes between phones. |
| `retired-mid-match` | Best of 5, `retired_by` 1, fewer games than `best_of`, the last one unfinished. |
| `retired-before-any-game` | `games` empty. |
| `correction` | `replaces` is the `hash` of `completed-best-of-3`. |
| `unrated` | `rated` false, one signature. |
| `longest` | Best of 7, every score 24 or more (two CBOR bytes each), retired in game 7, a correction, two signatures. 406 bytes and 614 QR characters. |
| `second-signature-by-pycose` | The second signature was appended by pycose, a second implementation, over the received payload bytes. Its bytes equal the API codec's. |
| `merged-player` | Names a player that a merge later points elsewhere. Its `note` says not to refuse it. |
| `one-key-for-both-players` | `cy` approves for both sides. |
| `two-keys-for-one-player` | `ann` and `cy` both approve for side 0, then `bo` for side 1. Three signatures, 459 bytes. |
| `same-signature-twice` | The same COSE_Signature twice. `approvals` has one entry. |

Invalid, `malformed` unless marked:

| Name | The one fault |
| --- | --- |
| `tampered-payload` | `bad_signature`. `iat` plus one, re-encoded deterministically, with the signatures kept. |
| `unknown-kid` | `unknown_key`. The second signature is by a key the directory doesn't hold. |
| `payload-reencoded-in-another-map-order` | The second signer re-encoded the payload with the result map's keys in reverse order and signed that. |
| `payload-integer-not-shortest` | `best_of` as `0x18 0x03`. |
| `unknown-result-key` | Result key `9`. |
| `result-key-as-text` | Text `"1"` for result key 1. A JavaScript decoder that builds plain objects accepts it. |
| `equal-player-ids` | Both players the same. |
| `retired-by-without-retirement` | `ending` 0 with key 7. |
| `retirement-without-retired-by` | `ending` 1 without key 7. |
| `match-id-as-uuid-tag` | The match id as tag 37. |
| `rated-as-integer` | `rated` as `1`. |
| `issued-at-as-float` | `iat` as a float64, as `Date.now() / 1000` makes it. |
| `tag-18` | COSE_Sign1's tag in place of 98. |
| `body-protected-header-as-empty-map` | `h'a0'` in place of `h''`. Some COSE libraries write this. |
| `envelope-not-deterministic` | An indefinite-length signature array. |
| `no-signatures` | An empty signature array. |
| `signer-unprotected-header-not-empty` | The kid copied into the unprotected header. |
| `signer-alg-es384` | `alg` -35. |
| `signer-alg-label-true` | `alg`'s label as CBOR `true`. A decoder whose maps treat `true` as 1 accepts it. |
| `signer-side-2` | The signer's `"player"` is 2. |
| `signer-side-as-bool` | The signer's `"player"` is CBOR `true`. |
| `signer-missing-player` | No `"player"` header. |
| `signature-63-bytes` | The signature is one byte short. |
| `qr-wrong-prefix` | `FMR2:`. |
| `qr-invalid-base45` | A Base45 group over 65535. |
| `link-standard-base64-padded` | The link in standard base64, with its `=` padding. |
| `envelope-trailing-byte` | A zero byte after the envelope. |
| `more-games-than-best-of` | Four games in a best of 3. |
| `missing-result-key` | No `rated` in the result map. |
| `duplicate-result-key` | `best_of` twice in the result map. |

### Traps the vectors pin

- Python. `True == 1 == 1.0` as dict keys and in `in` tests. Check every key
  and integer with `type(x) is int`.
- JavaScript. A plain object merges the integer key `1` with the text key
  `"1"`. Decode maps as `Map`.
- Every platform. A CBOR library that tags UUIDs (tag 37), writes `iat` as a
  float, or writes an empty protected header as `h'a0'` produces payloads the
  server refuses. Encode by hand to the tables. The vectors are the check.
- base64url. Python's `urlsafe_b64decode` drops characters outside the
  alphabet and accepts padding. Decode strictly: decode, encode again,
  compare.
- Android. The Keystore signs in DER. Convert to 32-byte `r` and `s`,
  left-padded.

## Worked example

The first vector, `completed-best-of-3`, has this payload in CBOR diagnostic
notation:

```
{
  6: 1793534400,
  "fortymm/match-result/v1": {
    1: h'653e264099fe56ba9f0114dd69f69a2d',
    2: 3,
    3: true,
    4: [h'1f67b354b11e52edbf28a480821231cc', h'6c47577f0fea50869939e4f81f2a7b1c'],
    5: [[11, 7], [9, 11], [11, 4]],
    6: 0
  }
}
```

Its payload is 103 bytes and its hash is
`65f55d6a2e3c88487360e522698097f7a18183104be25757f46726a938446c5a`. Its first
signer's protected header is

```
{
  1: -7,
  4: h'77517e3498d560ace130b511db2f41114abccf80abb69e82ef0d343c39b26755',
  "player": 0
}
```

which encodes as `a3 01 26 04 5820 <kid> 66 "player" 00`. The envelope is 343
bytes, the QR text 520 characters and the link 480. The API's test
`test_the_first_vector_matches_the_spec_example` decodes the payload with plain
cbor2 and compares it with this structure.
