//! Generated usernames (design section 8.4): `adjective-animal-suffix`, such
//! as `agile-meerkat-4b8z`, computed from a player id and nothing else, so any
//! device gets the same name with no server.
//!
//! **Provisional** (FORMAT.md section 2). The player id, read as a 256-bit
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

    /// The id whose big-endian value is `value`.
    fn id_of(value: u64) -> PlayerId {
        let mut bytes = [0u8; 32];
        bytes[24..].copy_from_slice(&value.to_be_bytes());
        PlayerId::from_bytes(bytes)
    }

    #[test]
    fn zero_takes_the_first_word_of_each_list() {
        assert_eq!(
            id_of(0).username(4).unwrap(),
            format!("{}-{}-0000", ADJECTIVES[0], ANIMALS[0])
        );
    }

    #[test]
    fn the_digits_are_taken_in_mixed_radix_by_the_lists_lengths() {
        // n = 5 + |ADJECTIVES| * (7 + |ANIMALS| * (3 + 29 * 11)).
        let (adjectives, animals) = (ADJECTIVES.len() as u64, ANIMALS.len() as u64);
        let n = 5 + adjectives * (7 + animals * (3 + 29 * 11));
        assert_eq!(
            id_of(n).username(4).unwrap(),
            format!("{}-{}-3c00", ADJECTIVES[5], ANIMALS[7])
        );
        // One less than a whole adjective cycle is the last adjective.
        assert!(
            id_of(adjectives - 1)
                .username(4)
                .unwrap()
                .starts_with(&format!(
                    "{}-{}-",
                    ADJECTIVES[adjectives as usize - 1],
                    ANIMALS[0]
                ))
        );
    }

    #[test]
    fn every_word_is_three_to_ten_lower_case_ascii_letters() {
        for word in ADJECTIVES.iter().chain(ANIMALS.iter()) {
            assert!(
                (3..=10).contains(&word.len()) && word.bytes().all(|b| b.is_ascii_lowercase()),
                "{word:?}"
            );
        }
    }

    #[test]
    fn each_list_is_sorted_with_no_word_twice() {
        for list in [&ADJECTIVES[..], &ANIMALS[..]] {
            for pair in list.windows(2) {
                assert!(pair[0] < pair[1], "{:?} then {:?}", pair[0], pair[1]);
            }
        }
    }

    #[test]
    fn no_word_is_both_an_adjective_and_an_animal() {
        for word in ADJECTIVES {
            assert!(ANIMALS.binary_search(word).is_err(), "{word:?}");
        }
    }
}
