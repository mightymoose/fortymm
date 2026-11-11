//! The stored form of a signature, and conversion from what platforms return.
//!
//! A stored signature is 64 bytes: r then s, each 32 bytes big-endian, with
//! both in the range 1 to n-1 and s in the lower half of that range ("low S").
//! iOS and Android key stores return ASN.1 DER; WebCrypto returns the raw
//! 64 bytes. Neither promises low S, so conversion replaces a high s by n - s.
//! That needs only a 256-bit comparison and subtraction, done here, so the
//! conversion works in a build with no cryptography compiled in.
//!
//! Nothing in this crate creates a signature.

use std::fmt;

/// The order of the P-256 group, big-endian.
const ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];

/// Why bytes are not a signature this crate accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignatureError {
    /// Not 64 bytes (raw or stored form).
    WrongLength,
    /// Not strict DER for a sequence of two non-negative integers that each
    /// fit in 32 bytes.
    BadDer,
    /// r or s is zero, or not below the group order.
    OutOfRange,
    /// Stored form only: s is in the upper half of its range.
    HighS,
}

impl fmt::Display for SignatureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            SignatureError::WrongLength => "a raw signature must be 64 bytes",
            SignatureError::BadDer => "not a strict DER ECDSA signature",
            SignatureError::OutOfRange => "r or s is outside 1..n-1",
            SignatureError::HighS => "s is not in the lower half of its range",
        };
        f.write_str(text)
    }
}

impl std::error::Error for SignatureError {}

/// A signature in the stored form.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Signature([u8; 64]);

impl fmt::Debug for Signature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Signature({})", crate::hex::encode(&self.0))
    }
}

impl Signature {
    /// The size of the stored form.
    pub const LENGTH: usize = 64;

    /// From the raw form (WebCrypto, "IEEE P1363"): r then s, 32 bytes each.
    /// A high s is replaced by n - s.
    pub fn from_raw(raw: &[u8]) -> Result<Signature, SignatureError> {
        let raw: &[u8; 64] = raw.try_into().map_err(|_| SignatureError::WrongLength)?;
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&raw[..32]);
        s.copy_from_slice(&raw[32..]);
        Signature::normalised(r, s)
    }

    /// From ASN.1 DER (the iOS Secure Enclave and the Android Keystore):
    /// `SEQUENCE { INTEGER r, INTEGER s }`. A high s is replaced by n - s.
    pub fn from_der(der: &[u8]) -> Result<Signature, SignatureError> {
        // A P-256 signature is at most 72 bytes, so the sequence length is
        // always a single byte.
        let [0x30, length, body @ ..] = der else {
            return Err(SignatureError::BadDer);
        };
        if *length >= 0x80 || usize::from(*length) != body.len() {
            return Err(SignatureError::BadDer);
        }
        let (r, rest) = der_integer(body)?;
        let (s, rest) = der_integer(rest)?;
        if !rest.is_empty() {
            return Err(SignatureError::BadDer);
        }
        Signature::normalised(r, s)
    }

    /// From bytes that claim to be the stored form already. Nothing is
    /// changed: a high s is an error, because a stored record has one form.
    pub fn from_stored(stored: &[u8]) -> Result<Signature, SignatureError> {
        let stored: &[u8; 64] = stored.try_into().map_err(|_| SignatureError::WrongLength)?;
        let signature = Signature::from_raw(stored)?;
        if &signature.0 != stored {
            return Err(SignatureError::HighS);
        }
        Ok(signature)
    }

    /// The 64 stored bytes.
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }

    fn normalised(r: [u8; 32], s: [u8; 32]) -> Result<Signature, SignatureError> {
        let zero = [0u8; 32];
        if r == zero || s == zero || r >= ORDER || s >= ORDER {
            return Err(SignatureError::OutOfRange);
        }
        let negated = subtract(&ORDER, &s);
        // Arrays of big-endian bytes compare as the numbers they hold.
        let low = if s > negated { negated } else { s };
        let mut bytes = [0u8; 64];
        bytes[..32].copy_from_slice(&r);
        bytes[32..].copy_from_slice(&low);
        Ok(Signature(bytes))
    }
}

/// `a - b` for big-endian 256-bit numbers with `a >= b`.
fn subtract(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for index in (0..32).rev() {
        let mut digit = i16::from(a[index]) - i16::from(b[index]) - borrow;
        if digit < 0 {
            digit += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[index] = digit as u8;
    }
    out
}

/// Read one DER INTEGER and return it as 32 big-endian bytes with the rest of
/// the input.
fn der_integer(input: &[u8]) -> Result<([u8; 32], &[u8]), SignatureError> {
    let [0x02, length, rest @ ..] = input else {
        return Err(SignatureError::BadDer);
    };
    let length = usize::from(*length);
    if length == 0 || length > 33 || length > rest.len() {
        return Err(SignatureError::BadDer);
    }
    let (mut digits, rest) = rest.split_at(length);
    if digits[0] & 0x80 != 0 {
        // Negative.
        return Err(SignatureError::BadDer);
    }
    if digits[0] == 0 && digits.len() > 1 {
        if digits[1] & 0x80 == 0 {
            // A leading zero that the value does not need.
            return Err(SignatureError::BadDer);
        }
        digits = &digits[1..];
    }
    if digits.len() > 32 {
        return Err(SignatureError::BadDer);
    }
    let mut out = [0u8; 32];
    out[32 - digits.len()..].copy_from_slice(digits);
    Ok((out, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn half_order() -> [u8; 32] {
        // (n - 1) / 2, the largest low s.
        let mut out = [0u8; 32];
        let mut carry = 0u8;
        for (index, byte) in ORDER.iter().enumerate() {
            out[index] = (byte >> 1) | (carry << 7);
            carry = byte & 1;
        }
        out
    }

    fn raw(r: &[u8; 32], s: &[u8; 32]) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(r);
        out[32..].copy_from_slice(s);
        out
    }

    fn one() -> [u8; 32] {
        let mut out = [0u8; 32];
        out[31] = 1;
        out
    }

    #[test]
    fn low_s_boundary() {
        let half = half_order();
        // s = (n-1)/2 is the largest value that stays as it is.
        let kept = Signature::from_raw(&raw(&one(), &half)).unwrap();
        assert_eq!(&kept.as_bytes()[32..], &half);
        // s = (n-1)/2 + 1 = n - (n-1)/2 becomes (n-1)/2.
        let above = subtract(&ORDER, &half);
        assert!(above > half);
        let flipped = Signature::from_raw(&raw(&one(), &above)).unwrap();
        assert_eq!(&flipped.as_bytes()[32..], &half);
        assert_eq!(
            Signature::from_stored(&raw(&one(), &above)),
            Err(SignatureError::HighS)
        );
        assert!(Signature::from_stored(&raw(&one(), &half)).is_ok());
    }

    #[test]
    fn range() {
        let zero = [0u8; 32];
        let top = subtract(&ORDER, &one());
        assert_eq!(
            Signature::from_raw(&raw(&zero, &one())),
            Err(SignatureError::OutOfRange)
        );
        assert_eq!(
            Signature::from_raw(&raw(&one(), &zero)),
            Err(SignatureError::OutOfRange)
        );
        assert_eq!(
            Signature::from_raw(&raw(&ORDER, &one())),
            Err(SignatureError::OutOfRange)
        );
        assert_eq!(
            Signature::from_raw(&raw(&one(), &ORDER)),
            Err(SignatureError::OutOfRange)
        );
        // r = n-1 is in range; s = n-1 is in range and becomes 1.
        let edge = Signature::from_raw(&raw(&top, &top)).unwrap();
        assert_eq!(&edge.as_bytes()[..32], &top);
        assert_eq!(&edge.as_bytes()[32..], &one());
        assert_eq!(
            Signature::from_raw(&[0u8; 63]),
            Err(SignatureError::WrongLength)
        );
        assert_eq!(
            Signature::from_raw(&[0u8; 65]),
            Err(SignatureError::WrongLength)
        );
    }

    #[test]
    fn der_is_strict() {
        // r = 1, s = 2.
        let good = [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02];
        let signature = Signature::from_der(&good).unwrap();
        assert_eq!(signature.as_bytes()[31], 1);
        assert_eq!(signature.as_bytes()[63], 2);

        let bad: &[&[u8]] = &[
            &[],
            &[0x30],
            // Wrong outer tag.
            &[0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02],
            // Sequence length too short and too long.
            &[0x30, 0x05, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02],
            &[0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02],
            // Long-form length.
            &[0x30, 0x81, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02],
            // Trailing byte inside and outside the sequence.
            &[0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x00],
            &[0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x00],
            // An unnecessary leading zero.
            &[0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x02],
            // A negative integer.
            &[0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x02],
            // An empty integer.
            &[0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x02],
            // Only one integer.
            &[0x30, 0x03, 0x02, 0x01, 0x01],
            // Wrong inner tag.
            &[0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x02],
        ];
        for der in bad {
            assert_eq!(
                Signature::from_der(der),
                Err(SignatureError::BadDer),
                "{der:02x?}"
            );
        }

        // A 33-byte integer whose value needs more than 32 bytes.
        let mut wide = vec![0x30, 0x26, 0x02, 0x21, 0x01];
        wide.extend_from_slice(&[0u8; 32]);
        wide.extend_from_slice(&[0x02, 0x01, 0x02]);
        assert_eq!(Signature::from_der(&wide), Err(SignatureError::BadDer));
    }

    #[test]
    fn der_with_sign_padding() {
        // r has its top bit set, so DER pads it with a zero byte.
        let mut der = vec![0x30, 0x26, 0x02, 0x21, 0x00, 0x80];
        der.extend_from_slice(&[0u8; 31]);
        der.extend_from_slice(&[0x02, 0x01, 0x05]);
        let signature = Signature::from_der(&der).unwrap();
        assert_eq!(signature.as_bytes()[0], 0x80);
        assert_eq!(signature.as_bytes()[63], 5);
    }
}
