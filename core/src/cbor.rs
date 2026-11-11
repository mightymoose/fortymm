//! The restricted deterministic CBOR profile (FORMAT.md, "CBOR profile").
//!
//! Four types only: unsigned integers, byte strings, arrays and maps whose
//! keys are unsigned integers in strictly ascending order. Every integer and
//! length is written in its shortest form and every length is definite. Under
//! those rules a value has exactly one encoding, and [`decode`] accepts that
//! encoding and nothing else.

use std::fmt;

/// How deeply arrays and maps may nest. A record body is depth 0.
pub const MAX_DEPTH: usize = 16;

/// A value of the profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// An unsigned integer.
    Uint(u64),
    /// A byte string.
    Bytes(Vec<u8>),
    /// An array.
    Array(Vec<Value>),
    /// A map with unsigned integer keys. Decoding yields the entries in
    /// strictly ascending key order.
    Map(Vec<(u64, Value)>),
}

/// Why bytes are not a value of the profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CborError {
    /// The input ends inside a value.
    Truncated,
    /// Bytes follow the value.
    TrailingBytes,
    /// A type outside the profile: a negative integer, text, a tag, a float
    /// or a simple value. Holds the CBOR major type.
    UnsupportedType(u8),
    /// An integer or length that is not in its shortest form.
    NotShortest,
    /// An indefinite length, or a reserved length code.
    IndefiniteLength,
    /// A map key that is not an unsigned integer.
    KeyNotUint,
    /// Map keys that are not in strictly ascending order (this covers a
    /// repeated key).
    KeysNotAscending,
    /// Nesting deeper than [`MAX_DEPTH`].
    TooDeep,
    /// Inside a parcel only: a reference to a table entry that does not exist.
    BadReference,
}

impl fmt::Display for CborError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            CborError::Truncated => "the input ends inside a value",
            CborError::TrailingBytes => "bytes follow the value",
            CborError::UnsupportedType(_) => "a type outside the profile",
            CborError::NotShortest => "an integer or length not in its shortest form",
            CborError::IndefiniteLength => "an indefinite or reserved length",
            CborError::KeyNotUint => "a map key that is not an unsigned integer",
            CborError::KeysNotAscending => "map keys not in strictly ascending order",
            CborError::TooDeep => "nesting too deep",
            CborError::BadReference => "a reference to a missing table entry",
        };
        f.write_str(text)
    }
}

impl std::error::Error for CborError {}

pub(crate) const MAJOR_UINT: u8 = 0;
/// Negative integers are outside the profile. Inside a parcel the same major
/// type means "the byte string at this index of the parcel's table".
pub(crate) const MAJOR_REFERENCE: u8 = 1;
pub(crate) const MAJOR_BYTES: u8 = 2;
pub(crate) const MAJOR_ARRAY: u8 = 4;
pub(crate) const MAJOR_MAP: u8 = 5;

/// Write a CBOR head: the major type and its argument, in the shortest form.
pub(crate) fn write_head(out: &mut Vec<u8>, major: u8, argument: u64) {
    let top = major << 5;
    if argument < 24 {
        out.push(top | argument as u8);
    } else if argument <= 0xff {
        out.push(top | 24);
        out.push(argument as u8);
    } else if argument <= 0xffff {
        out.push(top | 25);
        out.extend_from_slice(&(argument as u16).to_be_bytes());
    } else if argument <= 0xffff_ffff {
        out.push(top | 26);
        out.extend_from_slice(&(argument as u32).to_be_bytes());
    } else {
        out.push(top | 27);
        out.extend_from_slice(&argument.to_be_bytes());
    }
}

pub(crate) fn write_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    write_head(out, MAJOR_BYTES, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

/// Encode a value. `reference` is asked about every byte string: if it
/// returns an index, a reference to that table entry is written instead of
/// the string (parcels only).
pub(crate) fn encode_with(
    value: &Value,
    out: &mut Vec<u8>,
    reference: &dyn Fn(&[u8]) -> Option<u64>,
) {
    match value {
        Value::Uint(n) => write_head(out, MAJOR_UINT, *n),
        Value::Bytes(bytes) => match reference(bytes) {
            Some(index) => write_head(out, MAJOR_REFERENCE, index),
            None => write_bytes(out, bytes),
        },
        Value::Array(items) => {
            write_head(out, MAJOR_ARRAY, items.len() as u64);
            for item in items {
                encode_with(item, out, reference);
            }
        }
        Value::Map(entries) => {
            assert!(
                entries.windows(2).all(|pair| pair[0].0 < pair[1].0),
                "map keys must be strictly ascending"
            );
            write_head(out, MAJOR_MAP, entries.len() as u64);
            for (key, item) in entries {
                write_head(out, MAJOR_UINT, *key);
                encode_with(item, out, reference);
            }
        }
    }
}

/// The one encoding of a value. Map entries must already be in strictly
/// ascending key order, which every value this crate builds or decodes is;
/// a map that is not panics.
pub fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    encode_with(value, &mut out, &|_| None);
    out
}

/// Decode exactly one value that fills the whole input.
pub fn decode(bytes: &[u8]) -> Result<Value, CborError> {
    let mut reader = Reader::new(bytes, None);
    let value = reader.value(0)?;
    reader.finish()?;
    Ok(value)
}

/// A strict reader over profile bytes.
pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
    /// The parcel's table, when references are allowed.
    table: Option<&'a [Vec<u8>]>,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8], table: Option<&'a [Vec<u8>]>) -> Self {
        Reader {
            bytes,
            position: 0,
            table,
        }
    }

    pub(crate) fn position(&self) -> usize {
        self.position
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    pub(crate) fn finish(&self) -> Result<(), CborError> {
        if self.remaining() == 0 {
            Ok(())
        } else {
            Err(CborError::TrailingBytes)
        }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], CborError> {
        if count > self.remaining() {
            return Err(CborError::Truncated);
        }
        let slice = &self.bytes[self.position..self.position + count];
        self.position += count;
        Ok(slice)
    }

    /// Read a head and insist on the shortest form.
    pub(crate) fn head(&mut self) -> Result<(u8, u64), CborError> {
        let first = self.take(1)?[0];
        let major = first >> 5;
        // Text, tags, floats and simple values: refused before their argument
        // is read, so a float's bits are never judged as a length.
        if matches!(major, 3 | 6 | 7) {
            return Err(CborError::UnsupportedType(major));
        }
        let argument = match first & 0x1f {
            small @ 0..=23 => u64::from(small),
            24 => {
                let value = u64::from(self.take(1)?[0]);
                if value < 24 {
                    return Err(CborError::NotShortest);
                }
                value
            }
            25 => {
                let raw = self.take(2)?;
                let value = u64::from(u16::from_be_bytes([raw[0], raw[1]]));
                if value <= 0xff {
                    return Err(CborError::NotShortest);
                }
                value
            }
            26 => {
                let raw = self.take(4)?;
                let value = u64::from(u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]));
                if value <= 0xffff {
                    return Err(CborError::NotShortest);
                }
                value
            }
            27 => {
                let raw = self.take(8)?;
                let mut wide = [0u8; 8];
                wide.copy_from_slice(raw);
                let value = u64::from_be_bytes(wide);
                if value <= 0xffff_ffff {
                    return Err(CborError::NotShortest);
                }
                value
            }
            _ => return Err(CborError::IndefiniteLength),
        };
        Ok((major, argument))
    }

    /// Read the head of an array and return its length.
    pub(crate) fn array_head(&mut self) -> Result<usize, CborError> {
        match self.head()? {
            (MAJOR_ARRAY, count) => self.count(count, 1),
            (major, _) => Err(CborError::UnsupportedType(major)),
        }
    }

    pub(crate) fn uint(&mut self) -> Result<u64, CborError> {
        match self.head()? {
            (MAJOR_UINT, value) => Ok(value),
            (major, _) => Err(CborError::UnsupportedType(major)),
        }
    }

    /// A byte string, or, where a table is set, a reference to one.
    pub(crate) fn bytes(&mut self) -> Result<Vec<u8>, CborError> {
        let (major, argument) = self.head()?;
        self.bytes_after_head(major, argument)
    }

    fn bytes_after_head(&mut self, major: u8, argument: u64) -> Result<Vec<u8>, CborError> {
        match major {
            MAJOR_BYTES => {
                let length = usize::try_from(argument).map_err(|_| CborError::Truncated)?;
                Ok(self.take(length)?.to_vec())
            }
            MAJOR_REFERENCE => {
                let table = self.table.ok_or(CborError::UnsupportedType(major))?;
                usize::try_from(argument)
                    .ok()
                    .and_then(|index| table.get(index))
                    .cloned()
                    .ok_or(CborError::BadReference)
            }
            other => Err(CborError::UnsupportedType(other)),
        }
    }

    /// A count of items that each take at least `least` bytes. Checking it
    /// against what is left keeps a hostile length from reserving memory.
    fn count(&self, count: u64, least: usize) -> Result<usize, CborError> {
        let count = usize::try_from(count).map_err(|_| CborError::Truncated)?;
        match count.checked_mul(least) {
            Some(bytes) if bytes <= self.remaining() => Ok(count),
            _ => Err(CborError::Truncated),
        }
    }

    pub(crate) fn value(&mut self, depth: usize) -> Result<Value, CborError> {
        if depth > MAX_DEPTH {
            return Err(CborError::TooDeep);
        }
        let (major, argument) = self.head()?;
        match major {
            MAJOR_UINT => Ok(Value::Uint(argument)),
            MAJOR_BYTES | MAJOR_REFERENCE => {
                Ok(Value::Bytes(self.bytes_after_head(major, argument)?))
            }
            MAJOR_ARRAY => {
                let count = self.count(argument, 1)?;
                let mut items = Vec::with_capacity(count);
                for _ in 0..count {
                    items.push(self.value(depth + 1)?);
                }
                Ok(Value::Array(items))
            }
            MAJOR_MAP => {
                let count = self.count(argument, 2)?;
                let mut entries: Vec<(u64, Value)> = Vec::with_capacity(count);
                for _ in 0..count {
                    let key = match self.head()? {
                        (MAJOR_UINT, key) => key,
                        _ => return Err(CborError::KeyNotUint),
                    };
                    if let Some((previous, _)) = entries.last()
                        && key <= *previous
                    {
                        return Err(CborError::KeysNotAscending);
                    }
                    entries.push((key, self.value(depth + 1)?));
                }
                Ok(Value::Map(entries))
            }
            other => Err(CborError::UnsupportedType(other)),
        }
    }
}

/// Call `visit` with every byte string in a value, in encoding order.
pub(crate) fn for_each_bytes<'a>(value: &'a Value, visit: &mut dyn FnMut(&'a [u8])) {
    match value {
        Value::Uint(_) => {}
        Value::Bytes(bytes) => visit(bytes),
        Value::Array(items) => {
            for item in items {
                for_each_bytes(item, visit);
            }
        }
        Value::Map(entries) => {
            for (_, item) in entries {
                for_each_bytes(item, visit);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(value: Value, expected: &[u8]) {
        assert_eq!(encode(&value), expected);
        assert_eq!(decode(expected), Ok(value));
    }

    #[test]
    fn shortest_heads_at_every_boundary() {
        round_trip(Value::Uint(0), &[0x00]);
        round_trip(Value::Uint(23), &[0x17]);
        round_trip(Value::Uint(24), &[0x18, 24]);
        round_trip(Value::Uint(255), &[0x18, 0xff]);
        round_trip(Value::Uint(256), &[0x19, 0x01, 0x00]);
        round_trip(Value::Uint(65_535), &[0x19, 0xff, 0xff]);
        round_trip(Value::Uint(65_536), &[0x1a, 0x00, 0x01, 0x00, 0x00]);
        round_trip(
            Value::Uint(u64::from(u32::MAX)),
            &[0x1a, 0xff, 0xff, 0xff, 0xff],
        );
        round_trip(
            Value::Uint(u64::from(u32::MAX) + 1),
            &[0x1b, 0, 0, 0, 1, 0, 0, 0, 0],
        );
        round_trip(
            Value::Uint(u64::MAX),
            &[0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        );
    }

    #[test]
    fn containers() {
        round_trip(Value::Bytes(vec![]), &[0x40]);
        round_trip(Value::Bytes(vec![1, 2]), &[0x42, 1, 2]);
        round_trip(Value::Array(vec![]), &[0x80]);
        round_trip(
            Value::Map(vec![
                (0, Value::Uint(1)),
                (9, Value::Array(vec![Value::Bytes(vec![7])])),
            ]),
            &[0xa2, 0x00, 0x01, 0x09, 0x81, 0x41, 0x07],
        );
    }

    #[test]
    fn everything_outside_the_profile_is_refused() {
        let cases: &[(&[u8], CborError)] = &[
            (&[], CborError::Truncated),
            (&[0x18], CborError::Truncated),
            (&[0x18, 23], CborError::NotShortest),
            (&[0x19, 0x00, 0xff], CborError::NotShortest),
            (&[0x1a, 0x00, 0x00, 0xff, 0xff], CborError::NotShortest),
            (
                &[0x1b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff],
                CborError::NotShortest,
            ),
            (&[0x58, 0x01, 0x00], CborError::NotShortest),
            (&[0x98, 0x00], CborError::NotShortest),
            (&[0xb8, 0x00], CborError::NotShortest),
            (&[0x20], CborError::UnsupportedType(1)),
            (&[0x60], CborError::UnsupportedType(3)),
            (&[0xc0, 0x00], CborError::UnsupportedType(6)),
            (&[0xf4], CborError::UnsupportedType(7)),
            (&[0xf9, 0x00, 0x00], CborError::UnsupportedType(7)),
            (&[0x5f, 0x41, 0x00, 0xff], CborError::IndefiniteLength),
            (&[0x9f, 0xff], CborError::IndefiniteLength),
            (&[0xbf, 0xff], CborError::IndefiniteLength),
            (&[0x1c], CborError::IndefiniteLength),
            (&[0x42, 0x01], CborError::Truncated),
            (&[0x82, 0x01], CborError::Truncated),
            (&[0x00, 0x00], CborError::TrailingBytes),
            (&[0xa1, 0x40, 0x00], CborError::KeyNotUint),
            (&[0xa2, 0x01, 0x00, 0x00, 0x00], CborError::KeysNotAscending),
            (&[0xa2, 0x01, 0x00, 0x01, 0x00], CborError::KeysNotAscending),
            // Lengths far beyond the input must fail without allocating.
            (
                &[0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
                CborError::Truncated,
            ),
            (
                &[0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
                CborError::Truncated,
            ),
            (
                &[0xbb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
                CborError::Truncated,
            ),
        ];
        for (bytes, error) in cases {
            assert_eq!(decode(bytes), Err(*error), "{bytes:02x?}");
        }
    }

    #[test]
    fn nesting_is_bounded() {
        let mut deep = vec![0x81; MAX_DEPTH];
        deep.push(0x00);
        assert!(decode(&deep).is_ok());
        let mut deeper = vec![0x81; MAX_DEPTH + 1];
        deeper.push(0x00);
        assert_eq!(decode(&deeper), Err(CborError::TooDeep));
    }
}
