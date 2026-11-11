//! The two platform signature formats, from software keys: DER (iOS, Android)
//! and raw r||s (WebCrypto). Cross-signing with real key stores is not
//! possible here; these use p256's software signer.

mod common;

use common::{CRYPTO, Rng, high_s, keys};
use fortymm_core::{Crypto, Signature, SignatureError};

#[test]
fn der_and_raw_give_the_same_stored_form_and_verify() {
    let mut rng = Rng::new(3);
    let mut high = 0;
    for key in keys() {
        for _ in 0..200 {
            let length = rng.below(300);
            let message = rng.bytes(length);
            let platform = key.sign_platform(&message);
            if platform.normalize_s().is_some() {
                high += 1;
            }
            let from_der = Signature::from_der(platform.to_der().as_bytes()).unwrap();
            let from_raw = Signature::from_raw(&platform.to_bytes()).unwrap();
            assert_eq!(from_der, from_raw);
            // The stored form is accepted as stored.
            assert_eq!(Signature::from_stored(from_der.as_bytes()), Ok(from_der));
            assert!(CRYPTO.verify_p256_sha256(
                key.public().as_bytes(),
                &message,
                from_der.as_bytes()
            ));
            // A high-s stored form is refused, and converting it gives the
            // same stored signature.
            let flipped = high_s(&from_der);
            assert_eq!(Signature::from_stored(&flipped), Err(SignatureError::HighS));
            assert_eq!(Signature::from_raw(&flipped), Ok(from_der));
            // The wrong message or key does not verify.
            let mut other = message.clone();
            other.push(1);
            assert!(!CRYPTO.verify_p256_sha256(
                key.public().as_bytes(),
                &other,
                from_der.as_bytes()
            ));
        }
    }
    // RFC 6979 signatures are high-s about half the time, so normalising
    // was exercised.
    assert!(high > 100, "{high}");
}

#[test]
fn verification_rejects_keys_that_are_not_points() {
    let key = &keys()[0];
    let message = b"m";
    let signature = Signature::from_der(&key.sign_der(message)).unwrap();
    let mut not_a_point = *key.public().as_bytes();
    // An x coordinate of all ones is not on P-256 for either sign.
    not_a_point[1..].fill(0xff);
    assert!(!CRYPTO.verify_p256_sha256(&not_a_point, message, signature.as_bytes()));
}
