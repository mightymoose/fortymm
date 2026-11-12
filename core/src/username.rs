//! Generated usernames (design section 8.4): `adjective-animal-suffix`, such
//! as `agile-meerkat-4b8z`, computed from a player id and nothing else, so any
//! device gets the same name with no server.
//!
//! **Provisional** (FORMAT.md section 14). The player id, read as a 256-bit
//! big-endian number, is taken apart digit by digit in mixed radix: the
//! remainder by the number of adjectives picks the adjective, then the
//! remainder by the number of animals picks the animal, then each remainder
//! by the size of the suffix alphabet picks the next suffix character. So a
//! longer suffix extends a shorter one: the five-character form starts with
//! the four-character form, which the server's "shortest free form" relies on
//! (design section 8.4, "Confirmation").

use std::fmt;

use crate::ids::PlayerId;
use crate::layout::username::{
    ADJECTIVES, ANIMALS, MAX_SUFFIX_LENGTH, MIN_SUFFIX_LENGTH, SUFFIX_ALPHABET,
};

/// A suffix length outside [`MIN_SUFFIX_LENGTH`] to [`MAX_SUFFIX_LENGTH`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadSuffixLength;

impl fmt::Display for BadSuffixLength {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "a username suffix is {MIN_SUFFIX_LENGTH} to {MAX_SUFFIX_LENGTH} characters"
        )
    }
}

impl std::error::Error for BadSuffixLength {}

impl PlayerId {
    /// The generated username, with a suffix of `suffix_length` characters
    /// (four or more). It depends on the id alone.
    pub fn username(&self, suffix_length: usize) -> Result<String, BadSuffixLength> {
        if !(MIN_SUFFIX_LENGTH..=MAX_SUFFIX_LENGTH).contains(&suffix_length) {
            return Err(BadSuffixLength);
        }
        let mut number = *self.as_bytes();
        let adjective = ADJECTIVES[divide(&mut number, ADJECTIVES.len())];
        let animal = ANIMALS[divide(&mut number, ANIMALS.len())];
        let suffix: String = (0..suffix_length)
            .map(|_| SUFFIX_ALPHABET[divide(&mut number, SUFFIX_ALPHABET.len())] as char)
            .collect();
        Ok(format!("{adjective}-{animal}-{suffix}"))
    }
}

/// Divide the big-endian number in place by `divisor`; return the remainder.
fn divide(number: &mut [u8; 32], divisor: usize) -> usize {
    let mut remainder = 0usize;
    for byte in number.iter_mut() {
        let value = (remainder << 8) | usize::from(*byte);
        *byte = (value / divisor) as u8;
        remainder = value % divisor;
    }
    remainder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn division_is_long_division() {
        // 0x0100 = 256 = 3 * 83 + 7.
        let mut number = [0u8; 32];
        number[30] = 1;
        assert_eq!(divide(&mut number, 83), 7);
        assert_eq!(number[31], 3);
        assert!(number[..31].iter().all(|&b| b == 0));
    }

    #[test]
    fn zero_and_the_largest_id_take_the_ends_of_the_lists() {
        let zero = PlayerId::from_bytes([0; 32]);
        assert_eq!(zero.username(4).unwrap(), "agile-alpaca-0000");
        // 2^256 - 1 is 63 modulo 64, twice, then the rest of the digits.
        let top = PlayerId::from_bytes([0xff; 32]);
        assert!(top.username(4).unwrap().starts_with("wise-zebra-"));
    }

    #[test]
    fn the_lists_hold_distinct_lower_case_words() {
        for list in [&ADJECTIVES[..], &ANIMALS[..]] {
            let mut sorted = list.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), list.len());
            assert!(
                list.iter()
                    .all(|word| !word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase()))
            );
        }
    }
}
