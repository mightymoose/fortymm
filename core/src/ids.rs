//! Computed ids (design section 4, "Derived ids"). No id is ever assigned.
//!
//! Every id is the SHA-256 digest of a *preimage*. Each has two functions: one
//! that returns the preimage, for a host that must hash asynchronously (a
//! browser's WebCrypto), and one that hashes it with a [`Crypto`].

use std::fmt;

use crate::crypto::Crypto;

/// The fixed labels. Each ends in a zero byte, so no label is a prefix of
/// another. Chosen by this implementation (FORMAT.md, "Ids").
pub mod label {
    /// Prefixed to a public key to give its account id.
    pub const ACCOUNT: &[u8] = b"fortymm.account.v1\0";
    /// Prefixed to a public key to give its own player id.
    pub const OWN_PLAYER: &[u8] = b"fortymm.own-player.v1\0";
    /// Prefixed to an outcome subject to give the outcome id.
    pub const OUTCOME: &[u8] = b"fortymm.outcome.v1\0";
}

macro_rules! id {
    ($(#[$meta:meta])* $name:ident, $length:expr) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name([u8; $length]);

        impl $name {
            /// The size in bytes.
            pub const LENGTH: usize = $length;

            /// Wrap bytes that are already known to be this id.
            pub const fn from_bytes(bytes: [u8; $length]) -> Self {
                $name(bytes)
            }

            /// The bytes.
            pub const fn as_bytes(&self) -> &[u8; $length] {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), crate::hex::encode(&self.0))
            }
        }
    };
}

id!(
    /// The id of a record: the hash of its body. The signature is not part of it.
    RecordId,
    32
);
id!(
    /// The id of the account a key belongs to before any merge.
    AccountId,
    32
);
id!(
    /// The id of a player: a key's own player, or an extra player.
    PlayerId,
    32
);
id!(
    /// The id of a match: the record id of its `match` record.
    MatchId,
    32
);
id!(
    /// The id of an outcome: the hash of a label and the subject.
    OutcomeId,
    32
);
id!(
    /// The first 8 bytes of an outcome id.
    Tag,
    8
);

/// A P-256 public key in compressed SEC1 form: 0x02 or 0x03, then the X
/// coordinate.
///
/// Constructing one checks the length and the first byte only. Whether the X
/// coordinate is on the curve takes field arithmetic, so it is decided by
/// signature verification: no signature verifies against a key that is not a
/// point.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PublicKey([u8; 33]);

impl PublicKey {
    /// The size in bytes.
    pub const LENGTH: usize = 33;

    /// From compressed SEC1 bytes.
    pub fn from_sec1_compressed(bytes: &[u8]) -> Option<PublicKey> {
        let bytes: [u8; 33] = bytes.try_into().ok()?;
        matches!(bytes[0], 0x02 | 0x03).then_some(PublicKey(bytes))
    }

    /// The 33 bytes.
    pub const fn as_bytes(&self) -> &[u8; 33] {
        &self.0
    }

    /// The preimage of [`PublicKey::account_id`].
    pub fn account_id_preimage(&self) -> Vec<u8> {
        labelled(label::ACCOUNT, &self.0)
    }

    /// The account this key belongs to before any merge.
    pub fn account_id(&self, crypto: &impl Crypto) -> AccountId {
        AccountId(crypto.sha256(&self.account_id_preimage()))
    }

    /// The preimage of [`PublicKey::own_player_id`].
    pub fn own_player_id_preimage(&self) -> Vec<u8> {
        labelled(label::OWN_PLAYER, &self.0)
    }

    /// The player that came into existence with this key's account.
    pub fn own_player_id(&self, crypto: &impl Crypto) -> PlayerId {
        PlayerId(crypto.sha256(&self.own_player_id_preimage()))
    }
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicKey({})", crate::hex::encode(&self.0))
    }
}

impl RecordId {
    /// The id of the match that a `match` record with this id creates.
    pub const fn as_match_id(&self) -> MatchId {
        MatchId(self.0)
    }

    /// The id of the extra player that a `player` record with this id creates.
    pub const fn as_extra_player_id(&self) -> PlayerId {
        PlayerId(self.0)
    }
}

impl OutcomeId {
    /// The first 8 bytes.
    pub fn tag(&self) -> Tag {
        let mut tag = [0u8; 8];
        tag.copy_from_slice(&self.0[..8]);
        Tag(tag)
    }
}

/// The preimage of an outcome id: the label, then the subject bytes.
pub(crate) fn outcome_id_preimage(subject: &[u8]) -> Vec<u8> {
    labelled(label::OUTCOME, subject)
}

pub(crate) fn outcome_id(crypto: &impl Crypto, subject: &[u8]) -> OutcomeId {
    OutcomeId(crypto.sha256(&outcome_id_preimage(subject)))
}

pub(crate) fn record_id(crypto: &impl Crypto, body: &[u8]) -> RecordId {
    RecordId(crypto.sha256(body))
}

fn labelled(label: &[u8], data: &[u8]) -> Vec<u8> {
    let mut preimage = Vec::with_capacity(label.len() + data.len());
    preimage.extend_from_slice(label);
    preimage.extend_from_slice(data);
    preimage
}
