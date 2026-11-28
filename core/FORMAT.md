# FortyMM core format

The design (`~/Development/fortymm/DESIGN-primitives.md`) describes the format in prose and assigns none of its numbers, labels or lists. This file records what this implementation chose. Every value here is in `src/layout.rs` or `src/ids.rs`, and `vectors/vectors.json` holds the golden vectors every build checks. Nothing is frozen before the first public release (design section 18).

## 1. Ids

Every id is SHA-256 (design section 4). This implementation chose the labels. Each ends in a zero byte, so no label is a prefix of another.

| Id | Preimage |
|---|---|
| Account id of a key | `"fortymm.account.v1\0"` followed by the 33-byte key |
| Own player id of a key | `"fortymm.own-player.v1\0"` followed by the 33-byte key |

**Public keys.** A key is P-256 in compressed SEC1 form, 33 bytes: `0x02` or `0x03`, then the X coordinate. WebCrypto exports a key's public half uncompressed (`0x04`, X, Y: 65 bytes); the core checks that point is on the curve and compresses it. Every build computes ids itself; no build needs a host to hash.

## 2. Generated usernames


**Provisional.** The design fixes the form (an adjective, an animal and a short suffix, such as `agile-meerkat-4b8z`), that it is computed from the player id alone, that the suffix is four characters or more, that its alphabet has no vowels, and that the word lists are part of the format and frozen once released (sections 8.3, "Moderating usernames", and 8.4). The scheme was chosen by this implementation, and the lists below, which replace its first 64-word placeholders, are its proposal for the user to approve. Changing a list (a word, its place or its length) changes every generated name, so the lists must be final before the first release.

- **Form:** `<adjective>-<animal>-<suffix>`, all lower case ASCII, joined by `-`.
- **Scheme:** read the 32-byte player id as one big-endian unsigned number n. The adjective is `ADJECTIVES[n mod 1007]`; then n becomes n div 1007. The animal is `ANIMALS[n mod 452]`; then n becomes n div 452. Each suffix character, in order, is `SUFFIX_ALPHABET[n mod 29]`, then n becomes n div 29. Because the digits are taken in order, a longer suffix always starts with the shorter one, so the server's "shortest free form" (section 8.4, "Confirmation") only ever adds characters to what a device showed.
- **Suffix alphabet:** `0123456789bcdfghjkmnpqrstvwxz`, 29 characters: the digits, then lower-case consonants without `l` (it looks like `1`) and `y`.
- **Suffix length:** 4 to 16 characters. Anything else is refused. 16 is a limit of this implementation; the design needs only "four or more".
- **Lists:** 1,007 adjectives and 452 animals, in `src/layout.rs` (`layout::username`), in alphabetical order, which is their value order. Each word is 3 to 10 lower-case ASCII letters, no word is in both lists, and each list holds a word once; the core's tests refuse a list that breaks any of these. The words were chosen to be inoffensive alone and in any pairing: positive or neutral adjectives, with nothing about bodies, appearance, age, health or belief; animals people recognise, by one common name. 1,007 × 452 × 29⁴ is about 322 billion four-character names (about 9.3 trillion five-character ones).

The id is a SHA-256 output (section 1), so it is already uniform and is not hashed again.
