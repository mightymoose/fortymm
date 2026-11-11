# FortyMM core byte format

`DESIGN-primitives.md` describes records and parcels in prose. Everything in this file is the byte-level detail it leaves open. **Every choice here was made by this implementation, not by the design.** Each is provisional: design section 18 says nothing is frozen before the first public release. Every number lives in `src/layout.rs`, so a change means editing that file and this one, then regenerating `vectors/vectors.json`.

Where the design does decide something, this file says so and cites the section.

## 1. CBOR profile

The design (section 4, "Algorithms") fixes the profile's types: unsigned integers, byte strings, arrays, and integer-keyed maps in ascending key order, with no floats, no free text and no indefinite lengths. This implementation adds the rules that make the encoding unique (R2):

- Every integer, length and count uses the shortest head (RFC 8949 section 4.2.1, "preferred serialization").
- Map keys are unsigned integers in **strictly** ascending order, so a repeated key is invalid.
- Negative integers, text, tags, floats and simple values (`true`, `false`, `null`) are refused. So are indefinite lengths and the reserved length codes 28 to 30.
- Arrays and maps nest at most 16 deep (`cbor::MAX_DEPTH`).
- The decoder accepts exactly one value that fills the input. Trailing bytes are refused.

Under these rules each value has exactly one encoding. As a second guard, the record decoder re-encodes what it decoded and refuses anything that differs. Fuzzing shows that guard never fires.

## 2. Record body

A body is one CBOR map. Keys 0 to 6 are the header and mean the same in every kind. Key 7 is reserved. Keys from 8 up are the kind's own fields.

| Key | Field | Type | Present |
|---|---|---|---|
| 0 | Format version | uint, currently **1** | always |
| 1 | Kind | uint (section 3) | always |
| 2 | Environment | uint (section 4) | always |
| 3 | Signer | bytes(33): compressed SEC1 P-256 point, first byte 0x02 or 0x03 | always |
| 4 | Random value | bytes(8) | always |
| 5 | Clock reading | uint, milliseconds since the Unix epoch | optional, display only |
| 6 | Stamp | bytes(8) | in `grant` and every identity request, and nowhere else |

The design fixes: the five header fields and their order (section 4, "Body layout"), the 33-byte signer, the 8-byte random value, the optional clock reading, and the stamp in grants and requests (sections 4 and 8.3). This implementation chose the keys, the stamp's size (8 bytes), the clock's unit, and the decision to put the stamp in the header range so that its key is the same in every kind.

**Format version.** One number for the whole layout. A record whose format version is not 1 is decoded only as far as the header and carried unchanged (section 6). The design says "the version of this layout" without saying whether a kind's layout has its own version. This implementation reads it as one version for the body as a whole. A new version of one kind's layout therefore needs a new format version. See question 7 in `README.md`.

**Signed message.** The signature is ECDSA P-256 with SHA-256 over the body bytes exactly (design section 4). Nothing is prepended. A body always begins with a CBOR map head followed by `00 01` (key 0, version 1), so a server challenge that the device signs for reading (section 8.3, "Reading") must be built so that it can never start that way. That is not specified yet.

## 3. Kind numbers

| Number | Name in code | Design name | Fields decoded |
|---|---|---|---|
| 1 | `hello` | `hello` | yes |
| 2 | `player` | `player` | yes |
| 3 | `match` | `match` | yes |
| 4 | `score` | `score` | yes |
| 5 | `result` | `result` | yes |
| 6 | `ruling` | `ruling` | yes |
| 7 | `close-match` | `close` (section 4) | yes |
| 8 | `grant` | `grant` | yes |
| 16 | `attach-email` | `attach-email` | **no**, carried as unknown |
| 17 | `join` | `join` | **no** |
| 18 | `same-person` | `same-person` | yes |
| 19 | `name` | `name` | **no** |
| 20 | `release` | `release` | yes |
| 21 | `revoke` | `revoke` | yes |
| 22 | `change-email` | `change-email` | **no** |
| 23 | `close-account` | `close` (section 8.3) | **no** |
| 24 | `suspend` | `suspend` | yes |
| 25 | `reinstate` | `reinstate` | yes |
| 26 | `clear-name` | `clear-name` | yes |

The design calls both 7 and 23 `close`. They are different kinds with different signers and effects, so they have separate numbers and separate names. Numbers 9 to 15 are left free for record kinds, and 16 to 31 hold the identity requests. Section 9 lists why five kinds are not decoded.

## 4. Environment numbers

| Number | Environment |
|---|---|
| 1 | production |
| 2 | UAT |
| 3 | development (a developer's own stack) |

An unknown environment number still decodes. Refusing a record from the wrong environment is the server's job (design section 6.2).

## 5. Kind fields

"id" means bytes(32). Lists are arrays. A field marked optional is omitted when absent, never written as an empty value.

| Kind | Key | Field | Type |
|---|---|---|---|
| `hello`, `player` | | none | |
| `match` | 8 | sides | array of exactly 2 arrays, each of 1 or more player ids |
| | 9 | terms | bytes, opaque |
| `score` | 8 | match | id |
| | 9 | slot | uint: 0 for the whole match, n for game n |
| | 10 | value | bytes, opaque |
| | 11 | replaces | array of record ids, possibly empty |
| `result` | 8 | subject | the subject (below) |
| | 9 | player it is given for | id |
| | 10 | supersedes | array of record ids, possibly empty |
| `ruling` | 8 | subject | the subject |
| `close-match` | 8 | match | id |
| | 9 | official result's tag | bytes(8), optional |
| `grant` | 8 | grant subject | map (below) |
| | 9 | side | uint: 1 giving, 2 receiving |
| `same-person` | 8, 9 | the two players | id, id |
| `release` | 8 | player | id |
| `revoke` | 8 | key | bytes(33), compressed point |
| `suspend`, `reinstate` | 8 | account, named by its own player | id |
| | 9 | staff member's own player | id |
| | 10 | reason code | uint |
| `clear-name` | 8 | player | id |
| | 9 | staff member's own player | id |
| | 10 | reason code | uint |

A decoded kind must have exactly these keys. Any other key is an error, so a known kind cannot gain a field without a new format version.

**Subject** of a `result` or `ruling` (design section 4, "Subject"): the array `[match id, seen list, result content]`. The seen list is an array of 8-byte tags, oldest first. The content is opaque bytes. The subject is embedded as a CBOR value, not wrapped in a byte string, so its bytes are a contiguous slice of the body, and a second signer copying them reproduces them exactly (R6).

**Grant subject** (design section 8.3): a map with key 0 the player, 1 the receiving account, 2 the account that leaves (optional), 3 the receiver's player that this one becomes the same as (optional), and 4 a random value, bytes(8). A record never holds an account id (sections 4.3 and 8.3, "Email proof"), so keys 1 and 2 name an account by one of its players. This implementation reads the grant table that way. See question 4 in `README.md`.

**Opaque fields.** Terms, result content and score values are product schemas with their own versions. The core carries them as bytes and does not read them.

## 6. Kinds the library does not interpret

A body whose kind number is not in the table above, whose kind is one of the five not decoded, or whose format version is not 1 still decodes:

- keys 0 to 4 must be present and well typed, and keys 5 and 6 well typed if present;
- every other entry is kept as it is (`Content::Other`), as long as the whole body is valid in the profile;
- the record verifies like any other, gets a record id, and travels in a parcel unchanged.

This is what design section 10 relies on ("Server does not yet understand the kind").

## 7. Ids

Every id is SHA-256 (design section 4). This implementation chose the labels. Each ends in a zero byte, so no label is a prefix of another.

| Id | Preimage |
|---|---|
| Record id | the body bytes |
| Account id of a key | `"fortymm.account.v1\0"` followed by the 33-byte key |
| Own player id of a key | `"fortymm.own-player.v1\0"` followed by the 33-byte key |
| Extra player id | the record id of the `player` record |
| Match id | the record id of the `match` record |
| Outcome id | `"fortymm.outcome.v1\0"` followed by the subject's bytes |
| Tag | the first 8 bytes of an outcome id |

Each id has a function that returns its preimage, so a host that hashes asynchronously, such as WebCrypto, can compute ids itself.

## 8. Signatures

- **Stored form:** 64 bytes, r then s, each 32 bytes big-endian (design section 4).
- **Range:** r and s must each be 1 to n - 1, where n is the order of the P-256 group.
- **Low S (chosen here):** s must be at most (n - 1) / 2. ECDSA accepts both (r, s) and (r, n - s), so without this rule one body has two valid stored signatures. Converting a platform signature replaces a high s with n - s. A stored signature with a high s is refused rather than changed, because stored bytes are never rebuilt (R6).
- **DER input** (iOS Secure Enclave, Android Keystore): strict DER, `30 len 02 len r 02 len s`. Short-form lengths only. Each integer is non-negative and has no unneeded leading zero, and its value fits in 32 bytes. Nothing may follow it.
- **Raw input** (WebCrypto): exactly 64 bytes, r then s.
- **Standalone record:** the CBOR array `[body bytes, signature bytes]`. It is used for a record outside a parcel and in the vectors.

The core never signs. No public function takes bytes and returns a signature.

## 9. Limits

| Limit | Value | Where |
|---|---|---|
| Largest body | 4,096 bytes | `record::MAX_BODY_LENGTH` |
| Deepest nesting | 16 | `cbor::MAX_DEPTH` |

The design sets no maximum body size. The review flagged this, and section 16 should list it as a parameter.

## 10. Parcel binary form

```
byte 0          container version, currently 1
CBOR array(3)
  uint          environment
  array         table: the byte strings stored once
  array         records, each array(2): [body map, signature bytes(64)]
4 bytes         checksum over every byte before it, big-endian
```

The design fixes the container version, the environment, the records in order, storing repeated byte strings once, and a checksum (section 6, "Binary form"). This implementation chose the rest.

- **Stored once.** A byte string goes into the table if it is at least 8 bytes long and appears at least twice across the parcel's bodies. Signatures are not considered. The table lists the strings in order of first appearance, walking the bodies in order and each body depth first. Inside a body, every occurrence of a table string is written as a *reference*: CBOR major type 1 (negative integers, which the profile never uses) with the table index as its argument. This catches the match id, player ids, signer keys, and the whole result content when both sides sign the same subject.
- **Bodies are written as maps, not as byte strings.** That lets references reach inside them. The receiver rebuilds each body by writing the map out again with every reference replaced. Because the profile has one encoding per value, those are the signed bytes exactly.
- **Canonical.** A parcel decodes only if encoding the result gives the identical bytes. So a table entry used once, an unused entry, or a string left unreferenced is damage.
- Every record must carry the parcel's environment, and a parcel holds at least one record.

## 11. Checksum

**CRC-32C** (the Castagnoli polynomial 0x1EDC6F41) computed most significant bit first, with initial register 0xFFFFFFFF and the result inverted. It is stored as 4 bytes, big-endian. The check value for the ASCII bytes `123456789` is `05440f15`. That differs from the usual reflected CRC-32C (`e3069283`), which processes each byte least significant bit first.

**Why MSB-first.** The text form writes bits most significant first, five to a character. With an MSB-first CRC, the bits a character covers are adjacent in the polynomial, so damage inside a run of characters is a burst in the CRC's sense. With the reflected CRC that holds only within a byte.

**Why a CRC and not a hash.** P2 is about accidental damage. A CRC gives guarantees, not just probabilities, for the damage messaging apps actually cause, and it costs 4 bytes, which is about 7 characters. Deliberate tampering is not P2's concern: every record is signed, and a forger can build a valid parcel from scratch whatever the checksum.

### What is detected

Rules that hold for every parcel:

| Damage to the text | Detected |
|---|---|
| Changes of case, spaces, tabs, line breaks, any Unicode whitespace | Ignored by design: the text parses to the original |
| A character outside the 32-character alphabet, including I, L, O, U and punctuation | **Always**, without the checksum |
| A length that no binary form has (5n mod 8 ≥ 5), or nonzero padding bits in the last character | **Always**, without the checksum |
| Any substitution confined to 6 consecutive characters, at the same length: one wrong character, a few adjacent typos, a swap of two adjacent characters | **Always**. These are bursts of at most 30 bits, and every CRC of degree 32 detects every burst of 32 bits or fewer. |
| Any change of at most 5 bits in total, anywhere, at the same length, in a parcel of up to 655 bytes (about 1,050 characters) | **Always**, by CRC-32C's Hamming distance of 6 up to 5,243 bits. That figure comes from Koopman's published tables and was not re-derived here. Two single-bit errors in two characters far apart are covered. Two arbitrary wrong characters far apart (up to 10 bits) are not. |
| Every single-character substitution, deletion and insertion, and every truncation, of a two-record parcel | Checked **exhaustively** by the tests: 36,172 variants, all rejected. That is evidence for that parcel, not a rule for every parcel. |

Detected with high probability only:

| Damage | Probability it goes undetected |
|---|---|
| A deletion, insertion or truncation: everything after it shifts, so it is not a burst | about 2⁻³² (1 in 4.3 billion) from the checksum alone. Then the text length must be valid, the container must decode, every record must decode strictly, and the parcel must re-encode identically. That makes it lower still, but the extra margin is not quantified. |
| Two or more substitutions further apart than 6 characters | the same |
| Two parcels pasted together | the same, and in practice the second parcel's bytes fail the container decode |

**Does this deliver P2?** P2 says "any change … makes the checksum fail" and "a damaged parcel is never accepted as a different parcel". No checksum of finite length can promise that for every change, because some change maps onto every possible checksum value. This choice delivers the second sentence for every damage pattern in the first table, and with probability at least 1 − 2⁻³² for everything else. It also never returns a *different* parcel by accident in the tests: 100,000 random multi-edit damages and every single-edit damage to a sample parcel came out as the original or `Damaged`. P2's first sentence should be reworded to say which damage is always detected and that other damage is detected with probability 1 − 2⁻³².

## 12. Text and link form

- **Alphabet:** `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, in value order. This is Crockford's base-32 set: digits, then capitals without I, L, O and U. The design fixes "32 characters, digits and capital letters" (section 6). This implementation chose which 32. Every character, and the whole link written in capitals, is in a QR code's alphanumeric set.
- **Packing:** bits most significant first, 5 per character. The last character is padded with zero bits, and there are no padding characters. A text of n characters is valid only if it is exactly the length some byte count encodes to and its padding bits are zero, so each binary form has exactly one text.
- **No look-alike mapping.** Crockford's decoder reads O as 0 and I and L as 1. This one does not: those letters are damage. Mapping them would make some changes parse silently, which P2 forbids as written.
- **Link:** `HTTPS://<HOST>/P/<text>`, with the host written in capitals (design section 6). Parsing first removes all whitespace and folds to capitals. Then, if the text starts with `HTTPS://`, it takes everything after the first `/P/` that follows a non-empty host made of letters, digits, `.`, `-` and `:`. A text without the prefix is parsed as it is. A query string, a fragment or a trailing slash makes it damage.

## 13. Splitting

`Parcel::split(max_chars)` returns parcels whose text is at most `max_chars` characters each, without the link prefix. The design fixes that every part is a complete parcel and that a request or grant is never split from the earlier requests and grants (section 6, "Order and splitting"). This implementation chose how:

- A record travels with what is needed to judge it, when the parcel holds it: the `match` record its match id names, and the `player` records that created players it names (P1).
- A grant, a request, or a record of a kind the library does not interpret (which may be a request) travels with every such record before it. Every record travels with every grant and request before it, as P1 requires ("For any record they also include every request and grant that is still held and entered the journal before it").
- Parts are filled greedily in parcel order. A record is added together with the later records that need it and nothing else outside the part (a match with its results), if that fits. When a record's needs were already sent in an earlier part, they are repeated. Delivering a record twice has no effect.
- Each part keeps the parcel's order. A record whose needs alone do not fit gives `SplitError::TooLarge`.

Because every record must travel with every earlier request, a parcel that starts with requests repeats them in every part. That follows from P1 as written, and a long backlog that holds requests can split badly as a result. `export` (the journal, not in this slice) can do better by choosing what goes in first.
