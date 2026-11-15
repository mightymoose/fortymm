//! The two product layouts (FORMAT.md section 15): the terms of a match and
//! the value of a score. Their exact bytes are golden vectors (`vectors.rs`).

mod common;

use common::Rng;
use fortymm_core::cbor::{self, Value};
use fortymm_core::layout::{score_value, terms};
use fortymm_core::{ScoreValue, Terms};

/// The best ofs the app offers.
const BEST_OFS: [u32; 4] = [1, 3, 5, 7];

fn every_terms() -> Vec<Terms> {
    BEST_OFS
        .into_iter()
        .flat_map(|best_of| [false, true].map(|rated| Terms::new(best_of, rated).unwrap()))
        .collect()
}

fn some_score_values() -> Vec<ScoreValue> {
    vec![
        ScoreValue::Cleared,
        ScoreValue::Points([11, 9]),
        ScoreValue::Points([0, 11]),
        ScoreValue::Points([24, 26]),
        ScoreValue::Points([u32::MAX, 0]),
    ]
}

#[test]
fn terms_read_back_as_written() {
    for best_of in BEST_OFS {
        for rated in [false, true] {
            let written = Terms::new(best_of, rated).unwrap();
            let read = Terms::read(&written.to_bytes()).expect("written terms read back");
            assert_eq!(
                (read.best_of(), read.rated()),
                (best_of, rated),
                "best of {best_of}, rated {rated}"
            );
        }
    }
}

#[test]
fn a_score_value_reads_back_as_written_and_a_cleared_one_as_cleared() {
    let score = ScoreValue::Points([11, 9]);
    assert_eq!(ScoreValue::read(&score.to_bytes()), Some(score));
    // The sides keep their order.
    let reversed = ScoreValue::Points([9, 11]);
    assert_eq!(ScoreValue::read(&reversed.to_bytes()), Some(reversed));
    assert_eq!(
        ScoreValue::read(&ScoreValue::Cleared.to_bytes()),
        Some(ScoreValue::Cleared)
    );
}

#[test]
fn rated_and_unrated_terms_differ() {
    for best_of in BEST_OFS {
        assert_ne!(
            Terms::new(best_of, true).unwrap().to_bytes(),
            Terms::new(best_of, false).unwrap().to_bytes(),
            "best of {best_of}"
        );
    }
}

/// Read the bytes as both layouts. Whatever reads must be exactly what
/// writing it gives: no second byte string means the same value. Returns
/// whether either read gave something.
fn read_both(bytes: &[u8]) -> bool {
    let terms = Terms::read(bytes);
    if let Some(terms) = terms {
        assert_eq!(terms.to_bytes(), bytes, "terms from {bytes:02x?}");
    }
    let value = ScoreValue::read(bytes);
    if let Some(value) = value {
        assert_eq!(value.to_bytes(), bytes, "score value from {bytes:02x?}");
    }
    terms.is_some() || value.is_some()
}

#[test]
fn another_version_or_damage_reads_as_nothing_and_never_panics() {
    // Another layout version, with everything else as version 1 has it.
    for version in [0, 2, 3, u64::MAX] {
        let other_terms = cbor::encode(&Value::Map(vec![
            (terms::key::VERSION, Value::Uint(version)),
            (terms::key::BEST_OF, Value::Uint(5)),
            (terms::key::RATED, Value::Uint(terms::RATED)),
        ]));
        assert_eq!(Terms::read(&other_terms), None, "terms version {version}");
        let points = Value::Array(vec![Value::Uint(11), Value::Uint(9)]);
        for entries in [
            vec![(score_value::key::VERSION, Value::Uint(version))],
            vec![
                (score_value::key::VERSION, Value::Uint(version)),
                (score_value::key::POINTS, points),
            ],
        ] {
            let other_value = cbor::encode(&Value::Map(entries));
            assert_eq!(
                ScoreValue::read(&other_value),
                None,
                "score value version {version}"
            );
        }
    }

    let written: Vec<Vec<u8>> = every_terms()
        .iter()
        .map(Terms::to_bytes)
        .chain(some_score_values().iter().map(ScoreValue::to_bytes))
        .collect();
    for bytes in &written {
        assert!(read_both(bytes), "{bytes:02x?} reads");
        // Cut short anywhere, or with anything after it: nothing.
        for length in 0..bytes.len() {
            assert!(!read_both(&bytes[..length]), "{bytes:02x?} cut to {length}");
        }
        for extra in [0x00, 0x01, 0xa0, 0xff] {
            let longer = [bytes.as_slice(), &[extra]].concat();
            assert!(!read_both(&longer), "{bytes:02x?} then {extra:02x}");
        }
        // Every one-byte change. Some give another value (best of 5 to best
        // of 7); `read_both` insists that those are that value's own bytes.
        for at in 0..bytes.len() {
            for byte in 0..=255u8 {
                let mut changed = bytes.clone();
                changed[at] = byte;
                read_both(&changed);
            }
        }
    }

    // Every byte string of up to two bytes, then random ones.
    read_both(&[]);
    for first in 0..=255u8 {
        read_both(&[first]);
        for second in 0..=255u8 {
            read_both(&[first, second]);
        }
    }
    let mut rng = Rng::new(15);
    let mut read = 0;
    for _ in 0..200_000 {
        let length = rng.below(24);
        read += usize::from(read_both(&rng.bytes(length)));
    }
    // Random changes to written bytes: several bytes at once, a byte removed
    // or put in.
    for _ in 0..200_000 {
        let mut damaged = written[rng.below(written.len())].clone();
        for _ in 0..1 + rng.below(3) {
            let at = rng.below(damaged.len().max(1));
            match rng.below(3) {
                0 if !damaged.is_empty() => damaged[at] = rng.next() as u8,
                1 if !damaged.is_empty() => {
                    damaged.remove(at);
                }
                _ => damaged.insert(at.min(damaged.len()), rng.next() as u8),
            }
        }
        read += usize::from(read_both(&damaged));
    }
    // Most damage reads as nothing; the rest read as another value's bytes.
    assert!(read < 40_000, "{read} damaged inputs read as something");
}
