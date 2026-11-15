//! The two product layouts (FORMAT.md section 15): the terms of a match and
//! the value of a score.
//!
//! A record carries each as opaque bytes (`match` terms, `score` value), and
//! decoding a record never reads them. These are the bytes inside. Each
//! layout has its own version, apart from the record's format version, and
//! is written in the same CBOR profile as a body, so a value has exactly one
//! encoding.
//!
//! Reading gives nothing for bytes of another version and for bytes that are
//! not exactly what writing produces. It never fails any other way.

use std::fmt;

use crate::cbor::{self, Value};
use crate::layout::{score_value, terms};

/// A best of that is not an odd number from 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadBestOf;

impl fmt::Display for BadBestOf {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("best of is an odd number, 1 or more")
    }
}

impl std::error::Error for BadBestOf {}

/// The terms of a match: best of how many games, and whether it is rated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Terms {
    best_of: u32,
    rated: bool,
}

impl Terms {
    /// Terms for a match that is best of `best_of` games. Best of is odd, so
    /// that one side wins more games than the other.
    pub fn new(best_of: u32, rated: bool) -> Result<Terms, BadBestOf> {
        if best_of.is_multiple_of(2) {
            return Err(BadBestOf);
        }
        Ok(Terms { best_of, rated })
    }

    /// Best of how many games.
    pub fn best_of(&self) -> u32 {
        self.best_of
    }

    /// Whether the match is rated.
    pub fn rated(&self) -> bool {
        self.rated
    }

    /// The bytes of a `match` record's terms field.
    pub fn to_bytes(&self) -> Vec<u8> {
        let rated = if self.rated {
            terms::RATED
        } else {
            terms::NOT_RATED
        };
        cbor::encode(&Value::Map(vec![
            (terms::key::VERSION, Value::Uint(terms::VERSION)),
            (terms::key::BEST_OF, Value::Uint(u64::from(self.best_of))),
            (terms::key::RATED, Value::Uint(rated)),
        ]))
    }

    /// Read terms. None for another layout version, and for any bytes
    /// [`Terms::to_bytes`] does not produce.
    pub fn read(bytes: &[u8]) -> Option<Terms> {
        let Ok(Value::Map(entries)) = cbor::decode(bytes) else {
            return None;
        };
        let [
            (terms::key::VERSION, Value::Uint(terms::VERSION)),
            (terms::key::BEST_OF, Value::Uint(best_of)),
            (terms::key::RATED, Value::Uint(rated)),
        ] = entries.as_slice()
        else {
            return None;
        };
        let rated = match *rated {
            terms::NOT_RATED => false,
            terms::RATED => true,
            _ => return None,
        };
        Terms::new(u32::try_from(*best_of).ok()?, rated).ok()
    }
}

/// The value of a `score` record: a game's final score, or "cleared".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScoreValue {
    /// The two sides' points, first side first.
    Points([u32; 2]),
    /// The score is cleared: the game has no score.
    Cleared,
}

impl ScoreValue {
    /// The bytes of a `score` record's value field.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut entries = vec![(score_value::key::VERSION, Value::Uint(score_value::VERSION))];
        if let ScoreValue::Points(points) = self {
            let points = points.map(|side| Value::Uint(u64::from(side)));
            entries.push((score_value::key::POINTS, Value::Array(points.to_vec())));
        }
        cbor::encode(&Value::Map(entries))
    }

    /// Read a score value. None for another layout version, and for any
    /// bytes [`ScoreValue::to_bytes`] does not produce.
    pub fn read(bytes: &[u8]) -> Option<ScoreValue> {
        let Ok(Value::Map(entries)) = cbor::decode(bytes) else {
            return None;
        };
        match entries.as_slice() {
            [(score_value::key::VERSION, Value::Uint(score_value::VERSION))] => {
                Some(ScoreValue::Cleared)
            }
            [
                (score_value::key::VERSION, Value::Uint(score_value::VERSION)),
                (score_value::key::POINTS, Value::Array(points)),
            ] => {
                let [Value::Uint(first), Value::Uint(second)] = points.as_slice() else {
                    return None;
                };
                Some(ScoreValue::Points([
                    u32::try_from(*first).ok()?,
                    u32::try_from(*second).ok()?,
                ]))
            }
            _ => None,
        }
    }
}
