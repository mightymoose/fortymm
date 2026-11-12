# core

The FortyMM shared core in Rust: the first three parts of design section 14 (`DESIGN-primitives.md`).

- **Record bytes.** The body layout, the restricted deterministic CBOR profile, strict decoding (R2), a typed constructor for each kind, and every computed id.
- **Signatures.** Converting DER (iOS, Android) and raw r and s (WebCrypto) to the stored 64-byte form, and verifying ECDSA P-256 with SHA-256 against the key in the body. The core never signs.
- **Parcels.** The binary form, the text and link form, parsing that returns the parcel or `Damaged`, and splitting.

Not here yet: the rules, journal and sync decisions, match terms and result content layouts (carried as opaque bytes), username generation, and the UniFFI wrappers for iOS and Android.

Every byte-level choice is in [`FORMAT.md`](FORMAT.md), and every number is in `src/layout.rs`.

## Running it

Everything runs in Docker through mise (see `CLAUDE.md` at the repository root). Rust is never installed on the host.

```sh
./bin/mise run core:validate                             # what CI runs
./bin/mise run core:test -- --test sizes -- --nocapture  # measured parcel sizes
./bin/mise run core:wasm                                 # WebAssembly sizes and vectors from Node
./bin/mise run core:python                               # vectors from Python
```

## Layout

| Path | What |
|---|---|
| `src/cbor.rs` | The CBOR profile: the encoder and the strict decoder |
| `src/record.rs` | Body layout, kinds, `Draft` (one constructor per kind), `Record` |
| `src/ids.rs` | Computed ids, their labels, and their preimages |
| `src/signature.rs` | The stored form, DER and raw conversion, low S |
| `src/crypto.rs` | The `Crypto` trait (SHA-256 and verification), and `Software`, the implementation every build uses |
| `src/parcel.rs` | Parcels: binary form, checksum, text and link, parse, split |
| `src/layout.rs` | Every number in the format |
| `tests/` | Golden vectors, record and parcel properties, damage fuzzing, signatures, sizes |
| `vectors/vectors.json` | The golden vectors, checked by every build |
| `bindings/wasm/` | Raw WebAssembly interface, the hand-written wrapper `fortymm-core.mjs`, and the Node vector runner |
| `bindings/python/` | The Python module (PyO3, stable ABI) and the Python vector runner |

## Purity, and cryptography

The library has no input or output, no clock and no random generator. The random value in a record is a parameter of `Draft::body`. Hashing and verification go through the `Crypto` trait, and `Software` (pure Rust: `sha2`, `p256`) implements it in every build, the WebAssembly one included: the browser uses WebCrypto only to sign, so every getter and id is synchronous there.

Nothing in the library takes bytes and returns a signature. Tests sign with software keys in `tests/common/`.

## Kinds of record it does not interpret

A record whose kind the library does not decode is still decoded as far as the header. It verifies, gets its id, and is carried in a parcel byte for byte (`Content::Other`). This covers kinds from a newer app, other format versions, and five identity requests whose fields the design does not settle: `attach-email`, `join`, `name`, `change-email` and `close-account`.

## Open questions for the design

These are questions of meaning, not encoding, so they were left open rather than invented. Each kind marked *not decoded* is carried as an unknown kind until it is settled.

1. **`close` names two kinds.** Closing a match (section 4) and closing an account (section 8.3) have different signers, fields and effects. Here they are `close-match` (7) and `close-account` (23). The design should give them two names.
2. **`name`: where is the username?** A record may hold no text and no username (sections 4.3 and 8.4), yet `name` chooses one. *Not decoded.*
3. **`attach-email`, `join`, `change-email`: what is the proof?** They "name the challenge", but Auth0 now handles email proof and the design has not caught up. `join` also needs its player choice ("same as" a named player, or separate). *Not decoded.*
4. **Grant subject: how is an account named?** The subject holds "the receiving account" and "the account that leaves", but a record never holds an account id. Here each is named by one of that account's players (section 8.3, "Email proof"). Which player, and what happens once two accounts manage that player, is open (review, decision 9).
5. **`close-account`: what does it carry?** It is signed by a key of the account or by the server for staff, and the two forms need different fields. *Not decoded.*
6. **Staff forms of `revoke`, `release`, `grant` and `change-email`.** Section 8.3 lets staff ask for these, signed by the server, and says a staff request names the account, the staff member and a reason. Only the forms an account's own key signs are decoded here. A server-signed `release` also needs to say which account stops managing.
7. **Format version: one per body or one per kind?** Section 4 says the field is "the version of this layout". Section 18 speaks of "a new version of that kind's layout". Here it is one version for the whole body, so changing one kind means a new format version.
8. **Fields read from prose.** Section 8.3 has no fields column. The fields of `same-person` (two players), `release` (the player), `revoke` (the key), and `suspend`, `reinstate` and `clear-name` (target, staff member, reason) were read from the Effect column and the "Staff actions" paragraph. Confirm them when section 8 settles.
9. **`score` slot and value.** The design says "slot (a game or the whole match), value". Here the slot is 0 for the whole match or n for game n, and the value is opaque bytes, as the result content is.
10. **No maximum body size.** 4,096 bytes was chosen here. Section 16 should list it as a parameter.
11. **The reading challenge.** A device proves itself by signing a server challenge (section 8.3, "Reading"). That challenge must be built so that it can never also be a valid record body, or the server could get a phone to sign a record. Nothing specifies this yet.
12. **One outcome id for an agreed outcome and a ruling with the same subject.** This is review section 5, finding 1, and it is implemented as the design says. The formula is permanent once released (section 18), so it needs deciding before then.
