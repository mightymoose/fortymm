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
//!
//! Built without the `crypto` feature, the module contains no cryptography.
//! The wrapper then hashes the preimages and verifies the signed message with
//! WebCrypto (design section 14).

// The exported functions take pointers into the module's own memory, written
// by the wrapper, which is the only way to pass bytes across this boundary
// without generated glue.
#![allow(unsafe_code)]
#![allow(clippy::missing_safety_doc)]

use std::cell::RefCell;

use fortymm_core::{Parcel, PublicKey, Record, Signature};

const OK: i32 = 0;
const INVALID: i32 = 1;
const NOT_APPLICABLE: i32 = 2;
const DAMAGED: i32 = 3;
#[cfg(feature = "crypto")]
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
        done(r.header().signer.as_bytes().to_vec())
    })
}

/// The preimage of the outcome id of a `result` or `ruling`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_record_outcome_preimage(pointer: *const u8, length: usize) -> i32 {
    with_record(unsafe { input(pointer, length) }, |r| match r.subject() {
        Some(subject) => done(subject.outcome_id_preimage()),
        None => fail(NOT_APPLICABLE, "not a result or ruling"),
    })
}

fn with_key(bytes: &[u8], then: impl FnOnce(PublicKey) -> Vec<u8>) -> i32 {
    match PublicKey::from_sec1_compressed(bytes) {
        Some(key) => done(then(key)),
        None => fail(INVALID, "not a compressed P-256 key"),
    }
}

/// The preimage of a key's account id.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_account_id_preimage(pointer: *const u8, length: usize) -> i32 {
    with_key(unsafe { input(pointer, length) }, |key| {
        key.account_id_preimage()
    })
}

/// The preimage of a key's own player id.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fmm_own_player_id_preimage(pointer: *const u8, length: usize) -> i32 {
    with_key(unsafe { input(pointer, length) }, |key| {
        key.own_player_id_preimage()
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
    let Some((environment, mut rest)) = bytes.split_first_chunk::<8>() else {
        return fail(INVALID, "no environment");
    };
    let mut records = Vec::new();
    while let Some((size, after)) = rest.split_first_chunk::<4>() {
        let size = u32::from_be_bytes(*size) as usize;
        if after.len() < size {
            return fail(INVALID, "truncated record list");
        }
        match Record::decode(&after[..size]) {
            Ok(record) => records.push(record),
            Err(error) => return fail(INVALID, error),
        }
        rest = &after[size..];
    }
    if !rest.is_empty() {
        return fail(INVALID, "truncated record list");
    }
    let environment = fortymm_core::Environment(u64::from_be_bytes(*environment));
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

#[cfg(feature = "crypto")]
mod with_crypto {
    use super::*;
    use fortymm_core::Software;

    /// The record id.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn fmm_record_id(pointer: *const u8, length: usize) -> i32 {
        with_record(unsafe { input(pointer, length) }, |r| {
            done(r.id(&Software).as_bytes().to_vec())
        })
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
}
