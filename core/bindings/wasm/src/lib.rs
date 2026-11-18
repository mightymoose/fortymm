//! The core for browsers, as a raw WebAssembly interface.
//!
//! No generated glue: the JavaScript wrapper (`fortymm-core.mjs`) copies bytes
//! into the module's memory with `fmm_alloc`, calls a function, and reads its
//! output from `fmm_out_ptr` and `fmm_out_len`. Every function takes bytes and
//! returns a status:
//!
//! | Status | Meaning |
//! |---|---|
//! | 0 | done; the output buffer holds the result |
//! | 1 | the input is not valid (the output holds the reason as text) |
//! | 2 | not applicable (for example, the outcome of a record that is not a result) |
//! | 3 | a damaged parcel (the output holds the reason as text) |
//! | 4 | the signature does not verify |

// The exported functions take pointers into the module's own memory, written
// by the wrapper, which is the only way to pass bytes across this boundary
// without generated glue.
#![allow(unsafe_code)]
#![allow(clippy::missing_safety_doc)]

use std::cell::RefCell;

use fortymm_core::{
    AssembleError, ClockReading, Draft, Environment, Parcel, PlayerId, PublicKey, Record,
    Signature, Software,
};

const OK: i32 = 0;
const INVALID: i32 = 1;
const NOT_APPLICABLE: i32 = 2;
const DAMAGED: i32 = 3;
const BAD_SIGNATURE: i32 = 4;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn output(bytes: Vec<u8>) {
    OUT.with(|out| *out.borrow_mut() = bytes);
}

fn done(bytes: Vec<u8>) -> i32 {
    output(bytes);
    OK
}

fn fail(status: i32, reason: impl ToString) -> i32 {
    output(reason.to_string().into_bytes());
    status
}

unsafe fn input<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    if length == 0 {
        return &[];
    }
    // SAFETY: the wrapper passes a region it allocated with fmm_alloc and
    // filled, and does not free it until the call returns.
    unsafe { std::slice::from_raw_parts(pointer, length) }
}

fn with_record(bytes: &[u8], then: impl FnOnce(Record) -> i32) -> i32 {
    match Record::decode(bytes) {
        Ok(record) => then(record),
        Err(error) => fail(INVALID, error),
    }
}

/// Reserve `length` bytes for the wrapper to write into.
#[unsafe(no_mangle)]
pub extern "C" fn fmm_alloc(length: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(length.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Release what `fmm_alloc` reserved.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_free(pointer: *mut u8, length: usize) {
    // SAFETY: the pointer and length are exactly what fmm_alloc returned and
    // was given.
    unsafe { drop(Vec::from_raw_parts(pointer, 0, length.max(1))) }
}

/// Where the last result is.
#[unsafe(no_mangle)]
pub extern "C" fn fmm_out_ptr() -> *const u8 {
    OUT.with(|out| out.borrow().as_ptr())
}

/// How long the last result is.
#[unsafe(no_mangle)]
pub extern "C" fn fmm_out_len() -> usize {
    OUT.with(|out| out.borrow().len())
}

/// Decode a standalone record strictly; output its re-encoding.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_decode(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| done(r.to_bytes()))
}

/// The body: the signed message, and the preimage of the record id.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_body(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| {
        done(r.body().to_vec())
    })
}

/// The stored 64-byte signature.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_signature(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| {
        done(r.signature().as_bytes().to_vec())
    })
}

/// The signer's 33-byte compressed key.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_signer(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| {
        done(r.signer().as_bytes().to_vec())
    })
}

// The getters. Each reports what the bytes say, not that the record counts,
// and gives status 2 (not applicable) for a record of another kind or one
// this library did not interpret.

fn getter(bytes: &[u8], get: impl FnOnce(&Record) -> Option<Vec<u8>>) -> i32 {
    with_record(bytes, |r| match get(&r) {
        Some(out) => done(out),
        None => fail(NOT_APPLICABLE, "not applicable to this record"),
    })
}

/// The match id of a `match` record.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_match_id(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.match_id(&Software).map(|id| id.as_bytes().to_vec())
    })
}

/// The two sides of a `match` record: for each, a player count (4 bytes,
/// big-endian) followed by that many 32-byte player ids. One count may be 0:
/// an anonymous side.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_sides(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.sides().map(|sides| {
            let mut out = Vec::new();
            for side in sides {
                out.extend((side.len() as u32).to_be_bytes());
                side.iter().for_each(|p| out.extend(p.as_bytes()));
            }
            out
        })
    })
}

/// The terms of a `match` record.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_terms(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.terms().map(<[u8]>::to_vec)
    })
}

/// Whether a `match` record names a player more than once: one byte, 1 or 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_repeats_player(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.repeats_player().map(|repeats| vec![u8::from(repeats)])
    })
}

/// The key that created a `match` or `player` record's match or player.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_creator(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.creator().map(|key| key.as_bytes().to_vec())
    })
}

/// The id of the extra player a `player` record creates.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_extra_player_id(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.extra_player_id(&Software)
            .map(|id| id.as_bytes().to_vec())
    })
}

/// The key a `hello` record introduces.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_introduced_key(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.introduced_key().map(|key| key.as_bytes().to_vec())
    })
}

/// The generated username of a player id. Input: the suffix length (4 bytes,
/// big-endian), then the 32-byte player id. Output: the name as UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_username(pointer: *const u8, length: usize) -> i32 {
    let bytes = unsafe { input(pointer, length) };
    let Some((suffix, player)) = bytes.split_first_chunk::<4>() else {
        return fail(INVALID, "no suffix length");
    };
    let Ok(player) = <[u8; 32]>::try_from(player) else {
        return fail(INVALID, "a player id is 32 bytes");
    };
    match PlayerId::from_bytes(player).username(u32::from_be_bytes(*suffix) as usize) {
        Ok(name) => done(name.into_bytes()),
        Err(error) => fail(INVALID, error),
    }
}

fn with_key(bytes: &[u8], then: impl FnOnce(PublicKey) -> Vec<u8>) -> i32 {
    match PublicKey::from_sec1_compressed(bytes) {
        Some(key) => done(then(key)),
        None => fail(INVALID, "not a compressed P-256 key"),
    }
}

/// The account id of a 33-byte compressed key.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_account_id(pointer: *const u8, length: usize) -> i32 {
    with_key(unsafe { input(pointer, length) }, |key| {
        key.account_id(&Software).as_bytes().to_vec()
    })
}

/// The own player id of a 33-byte compressed key.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_own_player_id(pointer: *const u8, length: usize) -> i32 {
    with_key(unsafe { input(pointer, length) }, |key| {
        key.own_player_id(&Software).as_bytes().to_vec()
    })
}

/// Convert a DER signature (iOS, Android) to the stored form.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_signature_from_der(pointer: *const u8, length: usize) -> i32 {
    match Signature::from_der(unsafe { input(pointer, length) }) {
        Ok(signature) => done(signature.as_bytes().to_vec()),
        Err(error) => fail(INVALID, error),
    }
}

/// Convert a raw r||s signature (WebCrypto) to the stored form.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_signature_from_raw(pointer: *const u8, length: usize) -> i32 {
    match Signature::from_raw(unsafe { input(pointer, length) }) {
        Ok(signature) => done(signature.as_bytes().to_vec()),
        Err(error) => fail(INVALID, error),
    }
}

/// Parse parcel text or a link (UTF-8); output the binary form.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_parcel_parse(pointer: *const u8, length: usize) -> i32 {
    let Ok(text) = std::str::from_utf8(unsafe { input(pointer, length) }) else {
        return fail(DAMAGED, "not UTF-8");
    };
    match Parcel::parse(text) {
        Ok(parcel) => done(parcel.to_binary()),
        Err(error) => fail(DAMAGED, error),
    }
}

fn with_parcel(bytes: &[u8], then: impl FnOnce(Parcel) -> i32) -> i32 {
    match Parcel::from_binary(bytes) {
        Ok(parcel) => then(parcel),
        Err(error) => fail(DAMAGED, error),
    }
}

/// The records of a binary parcel: for each, its length as 4 bytes
/// big-endian, then the standalone record.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_parcel_records(pointer: *const u8, length: usize) -> i32 {
    with_parcel(unsafe { input(pointer, length) }, |parcel| {
        let mut out = Vec::new();
        for record in parcel.records() {
            let bytes = record.to_bytes();
            out.extend((bytes.len() as u32).to_be_bytes());
            out.extend(bytes);
        }
        done(out)
    })
}

/// Build a parcel from records laid out as `fmm_parcel_records` writes them,
/// for the environment in the first 8 bytes (big-endian); output the binary
/// form.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_parcel_build(pointer: *const u8, length: usize) -> i32 {
    let bytes = unsafe { input(pointer, length) };
    let Some((environment, rest)) = bytes.split_first_chunk::<8>() else {
        return fail(INVALID, "no environment");
    };
    let Some(items) = unframe(rest) else {
        return fail(INVALID, "truncated record list");
    };
    let mut records = Vec::new();
    for item in items {
        match Record::decode(item) {
            Ok(record) => records.push(record),
            Err(error) => return fail(INVALID, error),
        }
    }
    let environment = Environment(u64::from_be_bytes(*environment));
    match Parcel::new(environment, records) {
        Ok(parcel) => done(parcel.to_binary()),
        Err(error) => fail(INVALID, error),
    }
}

/// The text form of a binary parcel.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_parcel_text(pointer: *const u8, length: usize) -> i32 {
    with_parcel(unsafe { input(pointer, length) }, |parcel| {
        done(parcel.text().into_bytes())
    })
}

/// The record id.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_id(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| {
        done(r.id(&Software).as_bytes().to_vec())
    })
}

/// Items laid out as `fmm_parcel_records` writes them: each as its length
/// (4 bytes, big-endian), then its bytes. None if the layout is broken.
fn unframe(mut bytes: &[u8]) -> Option<Vec<&[u8]>> {
    let mut items = Vec::new();
    while let Some((size, after)) = bytes.split_first_chunk::<4>() {
        let size = u32::from_be_bytes(*size) as usize;
        if after.len() < size {
            return None;
        }
        items.push(&after[..size]);
        bytes = &after[size..];
    }
    bytes.is_empty().then_some(items)
}

// Making a record (design section 4.4): the core builds the body, the
// platform signs it with its own key store, and the core assembles the record
// from the body and the converted signature, and verifies it.

/// The body of a `hello`, to sign. Input: the environment (8 bytes,
/// big-endian), whether there is a clock reading (1 byte, 1 or 0), the clock
/// reading in milliseconds since the Unix epoch (8 bytes, big-endian; ignored
/// when there is none), then two items laid out as `fmm_parcel_records`
/// writes them: the signer's 33-byte compressed key and the 8-byte random
/// value. Output: the body.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_hello_body(pointer: *const u8, length: usize) -> i32 {
    let bytes = unsafe { input(pointer, length) };
    let Some((environment, rest)) = bytes.split_first_chunk::<8>() else {
        return fail(INVALID, "no environment");
    };
    let Some((&[has_clock], rest)) = rest.split_first_chunk::<1>() else {
        return fail(INVALID, "no clock flag");
    };
    let Some((clock, rest)) = rest.split_first_chunk::<8>() else {
        return fail(INVALID, "no clock reading");
    };
    let Some([key, random]) = unframe(rest).and_then(|items| <[&[u8]; 2]>::try_from(items).ok())
    else {
        return fail(INVALID, "expected a key and a random value");
    };
    let Some(signer) = PublicKey::from_sec1_compressed(key) else {
        return fail(INVALID, "not a compressed P-256 key");
    };
    let Ok(random) = <[u8; 8]>::try_from(random) else {
        return fail(INVALID, "the random value is 8 bytes");
    };
    let clock = match has_clock {
        0 => None,
        1 => Some(ClockReading::from_unix_millis(u64::from_be_bytes(*clock))),
        _ => return fail(INVALID, "the clock flag is 0 or 1"),
    };
    let environment = Environment(u64::from_be_bytes(*environment));
    match Draft::hello().body(environment, signer, random, clock) {
        Ok(body) => done(body),
        Err(error) => fail(INVALID, error),
    }
}

/// Assemble a record from a body and its signature in the stored 64-byte
/// form (see `fmm_signature_from_raw`), laid out as `fmm_parcel_records`
/// writes them, and verify it. Output: the standalone record. Status 1 if
/// the body or the signature is not valid, 4 if the signature does not
/// verify.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_assemble(pointer: *const u8, length: usize) -> i32 {
    let bytes = unsafe { input(pointer, length) };
    let Some([body, signature]) =
        unframe(bytes).and_then(|items| <[&[u8]; 2]>::try_from(items).ok())
    else {
        return fail(INVALID, "expected a body and a signature");
    };
    let signature = match Signature::from_stored(signature) {
        Ok(signature) => signature,
        Err(error) => return fail(INVALID, error),
    };
    match Record::assemble_verified(body.to_vec(), signature, &Software) {
        Ok(record) => done(record.to_bytes()),
        Err(AssembleError::BadSignature) => fail(BAD_SIGNATURE, AssembleError::BadSignature),
        Err(error) => fail(INVALID, error),
    }
}

/// Verify the record's signature: 0 if it verifies, 4 if not.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_verify(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| {
        match r.verify(&Software) {
            Ok(()) => done(vec![]),
            Err(error) => fail(BAD_SIGNATURE, error),
        }
    })
}

/// The outcome id of a `result` or `ruling`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_outcome_id(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| {
        match r.outcome_id(&Software) {
            Some(id) => done(id.as_bytes().to_vec()),
            None => fail(NOT_APPLICABLE, "not a result or ruling"),
        }
    })
}

/// Split a binary parcel. The text limit is the first 4 bytes
/// (big-endian), the binary parcel follows. Output: each part as 4 bytes
/// of length then its binary form.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_parcel_split(pointer: *const u8, length: usize) -> i32 {
    let bytes = unsafe { input(pointer, length) };
    let Some((limit, binary)) = bytes.split_first_chunk::<4>() else {
        return fail(INVALID, "no limit");
    };
    with_parcel(binary, |parcel| {
        match parcel.split(u32::from_be_bytes(*limit) as usize, &Software) {
            Ok(parts) => {
                let mut out = Vec::new();
                for part in parts {
                    let binary = part.to_binary();
                    out.extend((binary.len() as u32).to_be_bytes());
                    out.extend(binary);
                }
                done(out)
            }
            Err(error) => fail(INVALID, error),
        }
    })
}

// ---- The product layouts (FORMAT.md section 15) ----------------------------
// The terms of a match and the value of a score: the bytes a record carries
// in its terms and value fields.

use fortymm_core::{ScoreValue, Terms};

/// The bytes of terms. Input: best of (4 bytes, big-endian), then whether
/// the match is rated (1 byte, 1 or 0).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_terms_bytes(pointer: *const u8, length: usize) -> i32 {
    let Ok([b0, b1, b2, b3, rated]) = <[u8; 5]>::try_from(unsafe { input(pointer, length) }) else {
        return fail(INVALID, "expected a best of and a rated flag");
    };
    let rated = match rated {
        0 => false,
        1 => true,
        _ => return fail(INVALID, "the rated flag is 0 or 1"),
    };
    match Terms::new(u32::from_be_bytes([b0, b1, b2, b3]), rated) {
        Ok(terms) => done(terms.to_bytes()),
        Err(error) => fail(INVALID, error),
    }
}

/// Read terms. Output: best of (4 bytes, big-endian), then whether the match
/// is rated (1 byte, 1 or 0). Status 2 for bytes that are not terms of this
/// layout version.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_terms_read(pointer: *const u8, length: usize) -> i32 {
    match Terms::read(unsafe { input(pointer, length) }) {
        Some(terms) => {
            let mut out = terms.best_of().to_be_bytes().to_vec();
            out.push(u8::from(terms.rated()));
            done(out)
        }
        None => fail(NOT_APPLICABLE, "not terms this library reads"),
    }
}

/// The bytes of a score value. Input: one byte, 0 for cleared; or 1, then
/// the two sides' points (4 bytes each, big-endian).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_score_value(pointer: *const u8, length: usize) -> i32 {
    let value = match unsafe { input(pointer, length) } {
        [0] => ScoreValue::Cleared,
        [1, a0, a1, a2, a3, b0, b1, b2, b3] => ScoreValue::Points([
            u32::from_be_bytes([*a0, *a1, *a2, *a3]),
            u32::from_be_bytes([*b0, *b1, *b2, *b3]),
        ]),
        _ => return fail(INVALID, "expected cleared, or two sides' points"),
    };
    done(value.to_bytes())
}

/// Read a score value. Output: laid out as `fmm_score_value` takes it.
/// Status 2 for bytes that are not a score value of this layout version.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_score_value_read(pointer: *const u8, length: usize) -> i32 {
    match ScoreValue::read(unsafe { input(pointer, length) }) {
        Some(ScoreValue::Cleared) => done(vec![0]),
        Some(ScoreValue::Points([first, second])) => {
            let mut out = vec![1];
            out.extend(first.to_be_bytes());
            out.extend(second.to_be_bytes());
            done(out)
        }
        None => fail(NOT_APPLICABLE, "not a score value this library reads"),
    }
}

// ---- Making a `player`, a `match` and a `score`, and reading a score ----
//
// Each body is made as a `hello`'s is and assembled with
// `fmm_record_assemble`. The input starts as `fmm_hello_body`'s does: the
// environment (8 bytes, big-endian), whether there is a clock reading (1
// byte, 1 or 0), the clock reading (8 bytes, big-endian), then items laid out
// as `fmm_parcel_records` writes them. The first two items are the signer's
// 33-byte compressed key and the 8-byte random value; the kind's own items
// follow. A list of ids is one item, itself laid out the same way: one
// 32-byte item per id.

/// Read the shared inputs, build the draft from the kind's own items, and
/// output its body. A bad key or random value fails with the same reason as
/// in `fmm_hello_body`.
fn make_body(bytes: &[u8], draft: impl FnOnce(&[&[u8]]) -> Result<Draft, String>) -> i32 {
    let Some((environment, rest)) = bytes.split_first_chunk::<8>() else {
        return fail(INVALID, "no environment");
    };
    let Some((&[has_clock], rest)) = rest.split_first_chunk::<1>() else {
        return fail(INVALID, "no clock flag");
    };
    let Some((clock, rest)) = rest.split_first_chunk::<8>() else {
        return fail(INVALID, "no clock reading");
    };
    let Some(items) = unframe(rest) else {
        return fail(INVALID, "truncated inputs");
    };
    let Some(([key, random], fields)) = items.split_first_chunk::<2>() else {
        return fail(INVALID, "expected a key and a random value");
    };
    let Some(signer) = PublicKey::from_sec1_compressed(key) else {
        return fail(INVALID, "not a compressed P-256 key");
    };
    let Ok(random) = <[u8; 8]>::try_from(*random) else {
        return fail(INVALID, "the random value is 8 bytes");
    };
    let clock = match has_clock {
        0 => None,
        1 => Some(ClockReading::from_unix_millis(u64::from_be_bytes(*clock))),
        _ => return fail(INVALID, "the clock flag is 0 or 1"),
    };
    let environment = Environment(u64::from_be_bytes(*environment));
    let draft = match draft(fields) {
        Ok(draft) => draft,
        Err(reason) => return fail(INVALID, reason),
    };
    match draft.body(environment, signer, random, clock) {
        Ok(body) => done(body),
        Err(error) => fail(INVALID, error),
    }
}

/// One 32-byte id.
fn id_of(bytes: &[u8], what: &str) -> Result<[u8; 32], String> {
    <[u8; 32]>::try_from(bytes).map_err(|_| format!("{what} is 32 bytes"))
}

/// A list of 32-byte ids, one item each.
fn ids_of(bytes: &[u8], what: &str) -> Result<Vec<[u8; 32]>, String> {
    let items = unframe(bytes).ok_or_else(|| format!("truncated list: {what}"))?;
    items.into_iter().map(|id| id_of(id, what)).collect()
}

/// The body of a `player`, to sign. It has no items of its own.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_player_body(pointer: *const u8, length: usize) -> i32 {
    make_body(unsafe { input(pointer, length) }, |fields| match fields {
        [] => Ok(Draft::player()),
        _ => Err("a player has no fields".into()),
    })
}

/// The body of a `match`, to sign. Its own items: the terms, then each of
/// the two sides as a list of player ids. One list may be empty (an
/// anonymous side), never both; with one empty, rated terms are refused.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_match_body(pointer: *const u8, length: usize) -> i32 {
    make_body(unsafe { input(pointer, length) }, |fields| {
        let [terms, first, second] = fields else {
            return Err("expected the terms and two sides".into());
        };
        let side = |bytes: &[u8]| -> Result<Vec<PlayerId>, String> {
            let ids = ids_of(bytes, "a player id")?;
            Ok(ids.into_iter().map(PlayerId::from_bytes).collect())
        };
        Draft::match_([side(first)?, side(second)?], terms.to_vec()).map_err(|e| e.to_string())
    })
}

/// The body of a `score`, to sign. Its own items: the 32-byte match id, the
/// slot (8 bytes, big-endian), the value, and the list of the record ids it
/// replaces.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_score_body(pointer: *const u8, length: usize) -> i32 {
    make_body(unsafe { input(pointer, length) }, |fields| {
        let [match_id, slot, value, replaces] = fields else {
            return Err("expected a match id, a slot, a value and the replaced ids".into());
        };
        let match_id = fortymm_core::MatchId::from_bytes(id_of(match_id, "a match id")?);
        let slot = <[u8; 8]>::try_from(*slot).map_err(|_| "the slot is 8 bytes".to_string())?;
        let replaces = ids_of(replaces, "a record id")?;
        Ok(Draft::score(
            match_id,
            u64::from_be_bytes(slot),
            value.to_vec(),
            replaces
                .into_iter()
                .map(fortymm_core::RecordId::from_bytes)
                .collect(),
        ))
    })
}

/// The record's kind by name, as UTF-8. Status 2 for a kind number the
/// design does not name.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_kind(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.kind().map(|kind| kind.name().as_bytes().to_vec())
    })
}

/// The match a `score` record is about.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_scored_match(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.scored_match().map(|id| id.as_bytes().to_vec())
    })
}

/// The slot of a `score` record: 8 bytes, big-endian.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_slot(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.slot().map(|slot| slot.to_be_bytes().to_vec())
    })
}

/// The value of a `score` record.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_value(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.value().map(<[u8]>::to_vec)
    })
}

/// The ids a `score` record replaces: 32 bytes each, one after another.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_replaces(pointer: *const u8, length: usize) -> i32 {
    getter(unsafe { input(pointer, length) }, |r| {
        r.replaces()
            .map(|ids| ids.iter().flat_map(|id| *id.as_bytes()).collect())
    })
}

// ---- A match's state (FORMAT.md section 16) ----

/// Lay items out as `fmm_parcel_records` writes them.
fn framed<I: AsRef<[u8]>>(items: impl IntoIterator<Item = I>) -> Vec<u8> {
    let mut out = Vec::new();
    for item in items {
        let item = item.as_ref();
        out.extend((item.len() as u32).to_be_bytes());
        out.extend(item);
    }
    out
}

/// The state of the match a set of records is about. Input: the records,
/// laid out as `fmm_parcel_records` writes them; bytes that are not a record
/// fail. Output, laid out the same way, seven items: the match id; the
/// creator's 33-byte key; each side as a list of player ids (two items); the
/// terms, empty when they do not read, or else best of (4 bytes, big-endian)
/// and rated (1 byte, 1 or 0); the games, a list with one item per game,
/// empty for none or else the two sides' points (4 bytes each, big-endian);
/// and the current entries, a list with one item per game, itself a list of
/// record ids. Status 2 when the set gives no state.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_match_state(pointer: *const u8, length: usize) -> i32 {
    let Some(items) = unframe(unsafe { input(pointer, length) }) else {
        return fail(INVALID, "truncated record list");
    };
    let mut records = Vec::new();
    for item in items {
        match Record::decode(item) {
            Ok(record) => records.push(record),
            Err(error) => return fail(INVALID, error),
        }
    }
    let Some(state) = fortymm_core::match_state(&records, &Software) else {
        return fail(NOT_APPLICABLE, "no state: the records hold no single match");
    };
    let side = |side: &[PlayerId]| framed(side.iter().map(PlayerId::as_bytes));
    let terms = state.terms.map_or_else(Vec::new, |terms| {
        let mut out = terms.best_of().to_be_bytes().to_vec();
        out.push(u8::from(terms.rated()));
        out
    });
    let games = framed(state.games.iter().map(|game| {
        game.map_or_else(Vec::new, |[first, second]| {
            [first.to_be_bytes(), second.to_be_bytes()].concat()
        })
    }));
    let current = framed(
        state
            .current
            .iter()
            .map(|ids| framed(ids.iter().map(fortymm_core::RecordId::as_bytes))),
    );
    done(framed([
        state.match_id.as_bytes().to_vec(),
        state.creator.as_bytes().to_vec(),
        side(&state.sides[0]),
        side(&state.sides[1]),
        terms,
        games,
        current,
    ]))
}
