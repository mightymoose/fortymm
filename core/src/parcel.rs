//! Parcels: the one form in which records travel (design section 6).
//!
//! Binary form, all of it covered by the checksum:
//!
//! ```text
//! container version (1 byte)
//! CBOR array [
//!   environment,                    unsigned integer
//!   table,                          array of byte strings stored once
//!   records,                        array of [body, signature]
//! ]
//! checksum (4 bytes, big-endian)
//! ```
//!
//! Inside a body, a byte string that is in the table is written as a
//! reference: CBOR major type 1 (negative integers, which the profile never
//! uses) with the table index as its argument. The receiver writes each body
//! back out without references, which gives its exact bytes again because the
//! profile has one encoding per value.
//!
//! Text form: the binary form in a 32-character alphabet. Link form:
//! `HTTPS://<HOST>/P/<text>`. Parsing ignores case and whitespace, accepts the
//! text with or without the link, and returns the parcel or [`Damaged`].
//!
//! FORMAT.md states which kinds of damage are always detected.

use std::collections::{BTreeSet, HashMap};
use std::fmt;

use crate::cbor::{self, CborError, Value};
use crate::crypto::Crypto;
use crate::layout::parcel as layout;
use crate::record::{Content, Environment, Record, RecordError};

/// Why text or bytes are not a parcel. Every failure is reported as damage:
/// the parcel is rejected whole (P2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Damaged {
    /// A character outside the alphabet, a text length no binary form has,
    /// or nonzero padding bits.
    Text,
    /// A link that is not `HTTPS://<host>/P/<text>`.
    Link,
    /// Too short to hold a container version and a checksum.
    Short,
    /// The checksum does not match.
    Checksum,
    /// A container version this library does not know.
    ContainerVersion,
    /// The container is not the CBOR structure above.
    Container(CborError),
    /// A record inside is malformed.
    Record(RecordError),
    /// A record's environment differs from the parcel's.
    Environment,
    /// The parcel holds no records.
    Empty,
    /// The bytes are not the one encoding of the parcel they decode to (for
    /// example, a byte string stored once that appears only once).
    NotCanonical,
}

impl fmt::Display for Damaged {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "damaged parcel: ")?;
        match self {
            Damaged::Text => write!(f, "not parcel text"),
            Damaged::Link => write!(f, "not a parcel link"),
            Damaged::Short => write!(f, "too short"),
            Damaged::Checksum => write!(f, "checksum mismatch"),
            Damaged::ContainerVersion => write!(f, "unknown container version"),
            Damaged::Container(error) => write!(f, "bad container: {error}"),
            Damaged::Record(error) => write!(f, "bad record: {error}"),
            Damaged::Environment => write!(f, "records from another environment"),
            Damaged::Empty => write!(f, "no records"),
            Damaged::NotCanonical => write!(f, "not in canonical form"),
        }
    }
}

impl std::error::Error for Damaged {}

/// Why a parcel cannot be made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParcelError {
    /// No records.
    Empty,
    /// A record's environment differs from the parcel's. Holds its index.
    Environment(usize),
}

impl fmt::Display for ParcelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParcelError::Empty => write!(f, "a parcel needs at least one record"),
            ParcelError::Environment(index) => {
                write!(f, "record {index} is for another environment")
            }
        }
    }
}

impl std::error::Error for ParcelError {}

/// Why a parcel cannot be split to a size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitError {
    /// The record at this index, with what must travel with it, does not fit
    /// in one part.
    TooLarge(usize),
}

impl fmt::Display for SplitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SplitError::TooLarge(index) => write!(
                f,
                "record {index} and what must travel with it do not fit in one part"
            ),
        }
    }
}

impl std::error::Error for SplitError {}

/// An ordered list of records for one environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parcel {
    environment: Environment,
    records: Vec<Record>,
}

impl Parcel {
    /// A parcel of these records, in this order. Every record must be for
    /// `environment`.
    pub fn new(environment: Environment, records: Vec<Record>) -> Result<Parcel, ParcelError> {
        if records.is_empty() {
            return Err(ParcelError::Empty);
        }
        if let Some(index) = records
            .iter()
            .position(|record| record.header().environment != environment)
        {
            return Err(ParcelError::Environment(index));
        }
        Ok(Parcel {
            environment,
            records,
        })
    }

    /// The environment.
    pub fn environment(&self) -> Environment {
        self.environment
    }

    /// The records, in order.
    pub fn records(&self) -> &[Record] {
        &self.records
    }

    /// The binary form.
    pub fn to_binary(&self) -> Vec<u8> {
        let bodies: Vec<Value> = self
            .records
            .iter()
            .map(|record| cbor::decode(record.body()).expect("a record's body always decodes"))
            .collect();
        let table = shared_strings(&bodies);
        let index: HashMap<&[u8], u64> = table
            .iter()
            .enumerate()
            .map(|(position, bytes)| (bytes.as_slice(), position as u64))
            .collect();
        let reference = |bytes: &[u8]| index.get(bytes).copied();

        let mut out = vec![layout::CONTAINER_VERSION];
        cbor::write_head(&mut out, cbor::MAJOR_ARRAY, 3);
        cbor::write_head(&mut out, cbor::MAJOR_UINT, self.environment.0);
        cbor::write_head(&mut out, cbor::MAJOR_ARRAY, table.len() as u64);
        for bytes in &table {
            cbor::write_bytes(&mut out, bytes);
        }
        cbor::write_head(&mut out, cbor::MAJOR_ARRAY, self.records.len() as u64);
        for (record, body) in self.records.iter().zip(&bodies) {
            cbor::write_head(&mut out, cbor::MAJOR_ARRAY, 2);
            cbor::encode_with(body, &mut out, &reference);
            cbor::write_bytes(&mut out, record.signature().as_bytes());
        }
        let checksum = checksum(&out);
        out.extend_from_slice(&checksum.to_be_bytes());
        out
    }

    /// A parcel from its binary form.
    pub fn from_binary(bytes: &[u8]) -> Result<Parcel, Damaged> {
        if bytes.len() < 1 + 4 {
            return Err(Damaged::Short);
        }
        let (covered, stored) = bytes.split_at(bytes.len() - 4);
        if checksum(covered).to_be_bytes() != stored {
            return Err(Damaged::Checksum);
        }
        if covered[0] != layout::CONTAINER_VERSION {
            return Err(Damaged::ContainerVersion);
        }
        let container = &covered[1..];

        let mut reader = cbor::Reader::new(container, None);
        let (environment, table) = (|| {
            if reader.array_head()? != 3 {
                return Err(CborError::UnsupportedType(cbor::MAJOR_ARRAY));
            }
            let environment = reader.uint()?;
            let count = reader.array_head()?;
            let mut table = Vec::with_capacity(count);
            for _ in 0..count {
                table.push(reader.bytes()?);
            }
            Ok((Environment(environment), table))
        })()
        .map_err(Damaged::Container)?;

        let rest = &container[reader.position()..];
        let mut reader = cbor::Reader::new(rest, Some(&table));
        let raw = (|| {
            let count = reader.array_head()?;
            let mut raw = Vec::with_capacity(count);
            for _ in 0..count {
                if reader.array_head()? != 2 {
                    return Err(CborError::UnsupportedType(cbor::MAJOR_ARRAY));
                }
                let body = reader.value(0)?;
                let signature = reader.bytes()?;
                raw.push((body, signature));
            }
            reader.finish()?;
            Ok(raw)
        })()
        .map_err(Damaged::Container)?;

        let records = raw
            .into_iter()
            .map(|(body, signature)| Record::from_parts(&cbor::encode(&body), &signature))
            .collect::<Result<Vec<_>, _>>()
            .map_err(Damaged::Record)?;
        let parcel = Parcel::new(environment, records).map_err(|error| match error {
            ParcelError::Empty => Damaged::Empty,
            ParcelError::Environment(_) => Damaged::Environment,
        })?;
        if parcel.to_binary() != bytes {
            return Err(Damaged::NotCanonical);
        }
        Ok(parcel)
    }

    /// The text form.
    pub fn text(&self) -> String {
        base32_encode(&self.to_binary())
    }

    /// The link form, `HTTPS://<HOST>/P/<text>`. The host is written in
    /// capitals, so the whole link stays in a QR code's alphanumeric set.
    pub fn link(&self, host: &str) -> String {
        format!(
            "{}{}{}{}",
            layout::LINK_SCHEME,
            host.to_ascii_uppercase(),
            layout::LINK_PATH,
            self.text()
        )
    }

    /// Parse text or a link. Case and whitespace are ignored. Anything else
    /// that is not exactly a parcel's text is [`Damaged`].
    pub fn parse(input: &str) -> Result<Parcel, Damaged> {
        let cleaned: String = input
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| c.to_ascii_uppercase())
            .collect();
        let text = match cleaned.strip_prefix(layout::LINK_SCHEME) {
            Some(after_scheme) => {
                let (host, text) = after_scheme
                    .split_once(layout::LINK_PATH)
                    .ok_or(Damaged::Link)?;
                let host_ok = !host.is_empty()
                    && host
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'));
                if !host_ok {
                    return Err(Damaged::Link);
                }
                text
            }
            None => cleaned.as_str(),
        };
        Parcel::from_binary(&base32_decode(text)?)
    }

    /// Split into parcels whose text is at most `max_chars` characters each.
    ///
    /// Each part is a complete parcel. A record travels with what is needed
    /// to judge it, when this parcel holds that: the `match` record it names,
    /// and the `player` records that created players it names (P1). A grant,
    /// a request, or a record of a kind this library does not know (which
    /// may be a request) travels with every such record before it, and every
    /// record travels with every grant and request before it (design section
    /// 6, "Order and splitting"). Such a record can therefore appear in more
    /// than one part; delivering a record twice has no effect.
    ///
    /// The parts list every record at least once, each part keeps this
    /// parcel's order, and a parcel that already fits is returned unchanged.
    pub fn split(&self, max_chars: usize, crypto: &impl Crypto) -> Result<Vec<Parcel>, SplitError> {
        let count = self.records.len();
        let ids: Vec<[u8; 32]> = self
            .records
            .iter()
            .map(|record| *record.id(crypto).as_bytes())
            .collect();
        let creators: HashMap<[u8; 32], usize> = self
            .records
            .iter()
            .enumerate()
            .filter(|(_, record)| {
                matches!(record.content(), Content::Match { .. } | Content::Player)
            })
            .map(|(index, _)| (ids[index], index))
            .collect();

        // Direct dependencies of each record.
        let direct: Vec<Vec<usize>> = (0..count)
            .map(|index| {
                let record = &self.records[index];
                let mut needs: Vec<usize> = record
                    .content()
                    .referenced_ids()
                    .iter()
                    .filter_map(|id| creators.get(id).copied())
                    .filter(|&creator| creator != index)
                    .collect();
                needs.extend((0..index).filter(|&earlier| is_ordered(&self.records[earlier])));
                needs
            })
            .collect();
        let closure = |index: usize| {
            let mut set = BTreeSet::new();
            let mut stack = vec![index];
            while let Some(next) = stack.pop() {
                if set.insert(next) {
                    stack.extend(&direct[next]);
                }
            }
            set
        };
        let fits = |set: &BTreeSet<usize>| self.subset(set).text().len() <= max_chars;

        let mut parts: Vec<BTreeSet<usize>> = Vec::new();
        let mut current = BTreeSet::new();
        let mut placed = vec![false; count];
        for index in 0..count {
            if placed[index] {
                continue;
            }
            let needed = closure(index);
            // The record together with the later records that need it and
            // nothing else outside this part (a match with its results), so
            // a match is not cut off from its results when it can be helped.
            let mut unit = needed.clone();
            for later in index + 1..count {
                if placed[later] || !direct[later].contains(&index) {
                    continue;
                }
                let later_needs = closure(later);
                if later_needs
                    .iter()
                    .all(|m| *m == later || unit.contains(m) || current.contains(m))
                {
                    unit.insert(later);
                }
            }
            let joined = |add: &BTreeSet<usize>| {
                let mut set = current.clone();
                set.extend(add);
                set
            };
            if fits(&joined(&unit)) {
                current = joined(&unit);
            } else if unit.len() > needed.len() && fits(&unit) {
                parts.push(std::mem::replace(&mut current, unit));
            } else if fits(&joined(&needed)) {
                current = joined(&needed);
            } else if fits(&needed) {
                parts.push(std::mem::replace(&mut current, needed));
            } else {
                return Err(SplitError::TooLarge(index));
            }
            for &member in &current {
                placed[member] = true;
            }
        }
        if !current.is_empty() {
            parts.push(current);
        }
        Ok(parts.iter().map(|set| self.subset(set)).collect())
    }

    fn subset(&self, set: &BTreeSet<usize>) -> Parcel {
        Parcel {
            environment: self.environment,
            records: set
                .iter()
                .map(|&index| self.records[index].clone())
                .collect(),
        }
    }
}

/// Whether a record's place in the order matters: a grant, a request, or a
/// kind this library does not know.
fn is_ordered(record: &Record) -> bool {
    match record.kind() {
        Some(kind) => kind.carries_stamp(),
        None => true,
    }
}

/// The byte strings stored once: those at least
/// [`layout::SHARED_MIN_LENGTH`] long that appear at least twice across the
/// bodies, in order of first appearance.
fn shared_strings(bodies: &[Value]) -> Vec<Vec<u8>> {
    let mut order: Vec<&[u8]> = Vec::new();
    let mut counts: HashMap<&[u8], usize> = HashMap::new();
    for body in bodies {
        cbor::for_each_bytes(body, &mut |bytes| {
            if bytes.len() >= layout::SHARED_MIN_LENGTH {
                let count = counts.entry(bytes).or_insert(0);
                if *count == 0 {
                    order.push(bytes);
                }
                *count += 1;
            }
        });
    }
    order
        .into_iter()
        .filter(|bytes| counts[bytes] >= 2)
        .map(<[u8]>::to_vec)
        .collect()
}

/// CRC-32C (the Castagnoli polynomial), most significant bit first, initial
/// value all ones, result inverted.
pub fn checksum(data: &[u8]) -> u32 {
    let mut register = layout::CHECKSUM_INITIAL;
    for &byte in data {
        register ^= u32::from(byte) << 24;
        for _ in 0..8 {
            register = if register & 0x8000_0000 != 0 {
                (register << 1) ^ layout::CHECKSUM_POLYNOMIAL
            } else {
                register << 1
            };
        }
    }
    !register
}

/// Bits most significant first, five to a character; the last character is
/// padded with zero bits. No padding characters.
pub(crate) fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer = 0u32;
    let mut bits = 0;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(layout::ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(layout::ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// The inverse of [`base32_encode`], for capitals only. Refuses a length that
/// no byte string encodes to and nonzero padding bits, so each byte string
/// has exactly one text.
pub(crate) fn base32_decode(text: &str) -> Result<Vec<u8>, Damaged> {
    let length = text.len();
    let bytes = length * 5 / 8;
    if (bytes * 8).div_ceil(5) != length {
        return Err(Damaged::Text);
    }
    let mut out = Vec::with_capacity(bytes);
    let mut buffer = 0u32;
    let mut bits = 0;
    for character in text.bytes() {
        let value = layout::ALPHABET
            .iter()
            .position(|&a| a == character)
            .ok_or(Damaged::Text)? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    if buffer != 0 {
        return Err(Damaged::Text);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_check_value() {
        // The check value of this CRC (MSB-first CRC-32C) for "123456789",
        // confirmed by the plain polynomial division in
        // bindings/python/check_vectors.py. The usual reflected CRC-32C gives
        // e3069283 instead.
        assert_eq!(checksum(b"123456789"), 0x0544_0f15);
        assert_eq!(checksum(b""), 0);
    }

    #[test]
    fn base32_round_trip_and_uniqueness() {
        for length in 0usize..40 {
            let bytes: Vec<u8> = (0..length).map(|i| (i * 37 + 11) as u8).collect();
            let text = base32_encode(&bytes);
            assert_eq!(text.len(), (length * 8).div_ceil(5));
            assert_eq!(base32_decode(&text).unwrap(), bytes);
        }
        // "0" alone: 5 bits, no whole byte, so not a valid length.
        assert_eq!(base32_decode("0"), Err(Damaged::Text));
        // One byte is two characters; the last 2 bits must be zero.
        assert_eq!(base32_decode("01"), Err(Damaged::Text));
        assert_eq!(base32_decode("04"), Ok(vec![0x01]));
        assert_eq!(base32_decode("0I"), Err(Damaged::Text));
        assert_eq!(base32_decode("0a"), Err(Damaged::Text));
    }
}
