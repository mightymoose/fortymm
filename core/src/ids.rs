//! Computed ids (design section 4, "Derived ids"). No id is ever assigned.
//!
//! Every id is the SHA-256 digest of a *preimage* (FORMAT.md section 1). A key needs no
//! registration: its account and its own player are computed from it, so any device can work them
//! out with no server.

use std::fmt;

use p256::elliptic_curve::sec1::ToEncodedPoint;
use sha2::{Digest, Sha256};

/// The fixed labels. Each ends in a zero byte, so no label is a prefix of another. Chosen by this
/// implementation (FORMAT.md section 1).
pub mod label {
    /// Prefixed to a public key to give its account id.
    pub const ACCOUNT: &[u8] = b"fortymm.account.v1\0";
    /// Prefixed to a public key to give its own player id.
    pub const OWN_PLAYER: &[u8] = b"fortymm.own-player.v1\0";
}

macro_rules! id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name([u8; 32]);

        impl $name {
            /// The size in bytes.
            pub const LENGTH: usize = 32;

            /// Wrap bytes that are already known to be this id.
            pub const fn from_bytes(bytes: [u8; 32]) -> Self {
                $name(bytes)
            }

            /// The bytes.
            pub const fn as_bytes(&self) -> &[u8; 32] {
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
    /// The id of the account a key belongs to before any merge.
    AccountId
);
id!(
    /// The id of a player: a key's own player, or (later) an extra player.
    PlayerId
);

/// Bytes that are not a P-256 public key in the form asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadPublicKey;

impl fmt::Display for BadPublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a P-256 public key in the expected SEC1 form")
    }
}

impl std::error::Error for BadPublicKey {}

/// A P-256 public key in compressed SEC1 form, the 33 bytes a record carries (design section 4):
/// 0x02 or 0x03, then the X coordinate.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PublicKey([u8; 33]);

impl PublicKey {
    /// The size in bytes.
    pub const LENGTH: usize = 33;

    /// From compressed SEC1 bytes, as a record carries them. Checks the length and the first byte
    /// only: whether the X coordinate is on the curve takes field arithmetic, and no signature
    /// verifies against a key that is not a point.
    pub fn from_sec1_compressed(bytes: &[u8]) -> Result<PublicKey, BadPublicKey> {
        let bytes: [u8; 33] = bytes.try_into().map_err(|_| BadPublicKey)?;
        if matches!(bytes[0], 0x02 | 0x03) {
            Ok(PublicKey(bytes))
        } else {
            Err(BadPublicKey)
        }
    }

    /// From uncompressed SEC1 bytes (0x04, X, Y: 65 bytes), the form WebCrypto exports a key's
    /// public half in (`exportKey('raw')`). The point must be on the curve; it is then compressed
    /// (design section 14, "Signatures").
    pub fn from_sec1_uncompressed(bytes: &[u8]) -> Result<PublicKey, BadPublicKey> {
        if bytes.len() != 65 || bytes[0] != 0x04 {
            return Err(BadPublicKey);
        }
        let point = p256::PublicKey::from_sec1_bytes(bytes).map_err(|_| BadPublicKey)?;
        let compressed = point.to_encoded_point(true);
        PublicKey::from_sec1_compressed(compressed.as_bytes())
    }

    /// The 33 bytes.
    pub const fn as_bytes(&self) -> &[u8; 33] {
        &self.0
    }

    /// The account this key belongs to before any merge.
    pub fn account_id(&self) -> AccountId {
        AccountId(labelled_sha256(label::ACCOUNT, &self.0))
    }

    /// The player that came into existence with this key's account.
    pub fn own_player_id(&self) -> PlayerId {
        PlayerId(labelled_sha256(label::OWN_PLAYER, &self.0))
    }
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicKey({})", crate::hex::encode(&self.0))
    }
}

fn labelled_sha256(label: &[u8], data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(label);
    hasher.update(data);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_label_is_a_prefix_of_another() {
        assert!(!label::ACCOUNT.starts_with(label::OWN_PLAYER));
        assert!(!label::OWN_PLAYER.starts_with(label::ACCOUNT));
    }

    #[test]
    fn a_key_s_account_and_own_player_differ() {
        let key = PublicKey::from_sec1_compressed(&[2; 33]).unwrap();
        assert_ne!(key.account_id().as_bytes(), key.own_player_id().as_bytes());
    }

    #[test]
    fn a_compressed_key_must_start_with_two_or_three() {
        assert_eq!(PublicKey::from_sec1_compressed(&[4; 33]), Err(BadPublicKey));
    }

    #[test]
    fn a_compressed_key_is_33_bytes() {
        assert_eq!(PublicKey::from_sec1_compressed(&[2; 32]), Err(BadPublicKey));
    }

    #[test]
    fn an_uncompressed_key_off_the_curve_is_refused() {
        let mut bytes = [1u8; 65];
        bytes[0] = 0x04;
        assert_eq!(PublicKey::from_sec1_uncompressed(&bytes), Err(BadPublicKey));
    }

    #[test]
    fn a_compressed_key_is_not_taken_as_uncompressed() {
        assert_eq!(
            PublicKey::from_sec1_uncompressed(&[2; 33]),
            Err(BadPublicKey)
        );
    }
}
