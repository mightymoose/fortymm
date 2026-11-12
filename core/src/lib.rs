//! The FortyMM shared core: the first three parts of design section 14.
//!
//! - **Record bytes** ([`record`], [`ids`], [`cbor`]): the body layout, the
//!   restricted deterministic CBOR profile, strict decoding, a typed
//!   constructor per kind, and every computed id.
//! - **Signatures** ([`signature`], [`crypto`]): conversion of each platform's
//!   format to the stored 64-byte form, and verification. Nothing here signs.
//! - **Parcels** ([`parcel`]): the binary, text and link forms, parsing, and
//!   splitting.
//!
//! The library is pure: no input or output, no clock, no random generator.
//! Hashing and verification come from a [`Crypto`]; [`Software`] provides
//! both, in every build.
//!
//! Every number in the byte format is in [`layout`] and is described in
//! FORMAT.md.

#![forbid(unsafe_code)]

pub mod cbor;
pub mod crypto;
mod hex;
pub mod ids;
pub mod layout;
pub mod parcel;
pub mod record;
pub mod signature;

pub use crypto::Crypto;
pub use crypto::Software;
pub use ids::{AccountId, MatchId, OutcomeId, PlayerId, PublicKey, RecordId, Tag};
pub use parcel::{Damaged, Parcel, ParcelError, SplitError};
pub use record::{
    AssembleError, BadSignature, ClockReading, Content, Draft, DraftError, Environment, GrantSide,
    GrantSubject, Header, Kind, Record, RecordError, StaffFields, Stamp, Subject,
};
pub use signature::{Signature, SignatureError};
