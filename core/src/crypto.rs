//! The two cryptographic operations the core needs, behind a trait.
//!
//! The core hashes and verifies, and never signs. [`Software`] is the
//! implementation every build uses, the browser's included (design section
//! 14). The trait stays so tests can stand in for it.

/// SHA-256 and ECDSA P-256 verification.
///
/// An implementation must be a pure function of its arguments. The core checks
/// the encoding of the signature (range and low S) before it calls
/// [`Crypto::verify_p256_sha256`], so implementations cannot disagree about a
/// malleable or out-of-range signature.
pub trait Crypto {
    /// The SHA-256 digest of `data`.
    fn sha256(&self, data: &[u8]) -> [u8; 32];

    /// Whether `signature` (r then s, 32 big-endian bytes each) is a valid
    /// ECDSA P-256 signature over the SHA-256 digest of `message` for the
    /// compressed public key `public_key`. A key that is not a point on the
    /// curve gives `false`.
    fn verify_p256_sha256(
        &self,
        public_key: &[u8; 33],
        message: &[u8],
        signature: &[u8; 64],
    ) -> bool;
}

impl<T: Crypto + ?Sized> Crypto for &T {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        (**self).sha256(data)
    }

    fn verify_p256_sha256(
        &self,
        public_key: &[u8; 33],
        message: &[u8],
        signature: &[u8; 64],
    ) -> bool {
        (**self).verify_p256_sha256(public_key, message, signature)
    }
}

/// The built-in implementation, in pure Rust.
#[derive(Clone, Copy, Debug, Default)]
pub struct Software;

impl Crypto for Software {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(data).into()
    }

    fn verify_p256_sha256(
        &self,
        public_key: &[u8; 33],
        message: &[u8],
        signature: &[u8; 64],
    ) -> bool {
        use p256::ecdsa::signature::Verifier;
        let Ok(key) = p256::ecdsa::VerifyingKey::from_sec1_bytes(public_key) else {
            return false;
        };
        let Ok(signature) = p256::ecdsa::Signature::from_slice(signature) else {
            return false;
        };
        key.verify(message, &signature).is_ok()
    }
}
