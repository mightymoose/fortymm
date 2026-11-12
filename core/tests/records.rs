//! Record bytes: typed round trips, strict decoding (R2), the random value,
//! bit flips, kinds the library does not interpret, and the self-check.

mod common;

use common::{CRYPTO, ENV, Rng, fixtures, random, raw_body};
use fortymm_core::cbor::{self, CborError, Value};
use fortymm_core::record::MAX_BODY_LENGTH;
use fortymm_core::{
    AssembleError, Content, Draft, DraftError, Environment, Kind, Record, RecordError, Signature,
};

#[test]
fn every_fixture_decodes_to_itself_and_verifies() {
    let fixtures = fixtures();
    for (name, record) in &fixtures.records {
        let again = Record::decode(&record.to_bytes()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(&again, record, "{name}");
        assert_eq!(again.content(), record.content(), "{name}");
        assert!(again.verify(&CRYPTO).is_ok(), "{name}");
        assert_eq!(again.to_bytes(), record.to_bytes(), "{name}");
    }
}

#[test]
fn each_interpreted_kind_has_a_fixture() {
    let fixtures = fixtures();
    for kind in Kind::ALL.into_iter().filter(|kind| kind.is_interpreted()) {
        assert!(
            fixtures
                .records
                .iter()
                .any(|(_, record)| record.content().kind() == Some(kind)),
            "{kind:?}"
        );
    }
}

#[test]
fn kinds_the_library_does_not_interpret_are_carried_as_they_are() {
    let fixtures = fixtures();
    for name in [
        "unknown-kind",
        "name-not-interpreted",
        "future-format-version",
    ] {
        let record = fixtures.get(name);
        assert!(matches!(record.content(), Content::Other(_)), "{name}");
        assert!(record.verify(&CRYPTO).is_ok());
        assert_eq!(record.header().signer, fixtures.keys[0].public());
    }
    assert_eq!(fixtures.get("unknown-kind").kind(), None);
    assert_eq!(
        fixtures.get("name-not-interpreted").kind(),
        Some(Kind::Name)
    );
    assert_eq!(
        fixtures
            .get("future-format-version")
            .header()
            .format_version,
        2
    );
}

#[test]
fn the_two_closes_are_two_kinds() {
    assert_ne!(Kind::CloseMatch.number(), Kind::CloseAccount.number());
    assert_ne!(Kind::CloseMatch.name(), Kind::CloseAccount.name());
    let numbers: std::collections::BTreeSet<u64> = Kind::ALL.iter().map(|k| k.number()).collect();
    assert_eq!(numbers.len(), Kind::ALL.len());
}

#[test]
fn random_value_makes_two_records() {
    // Section 4.5: the same draft committed twice differs only in the random
    // value and has a different id.
    let fixtures = fixtures();
    let alice = &fixtures.keys[0];
    let draft = Draft::release(alice.own_player(), common::STAMP);
    let first = alice.commit(&draft, [1; 8], None);
    let second = alice.commit(&draft, [2; 8], None);
    assert_ne!(first.id(&CRYPTO), second.id(&CRYPTO));
    let differing: Vec<usize> = first
        .body()
        .iter()
        .zip(second.body())
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(first.body().len(), second.body().len());
    assert_eq!(differing.len(), 8, "only the random value differs");
    let span = differing[7] - differing[0];
    assert_eq!(span, 7, "and it is contiguous");

    // A body without the random value is malformed.
    let mut entries = match cbor::decode(first.body()).unwrap() {
        Value::Map(entries) => entries,
        _ => unreachable!(),
    };
    entries.retain(|(key, _)| *key != 4);
    let body = cbor::encode(&Value::Map(entries));
    let signature = alice.sign_body(&body);
    assert_eq!(
        Record::assemble(body, signature),
        Err(RecordError::MissingField(4))
    );
}

#[test]
fn the_random_value_is_not_part_of_the_subject() {
    let fixtures = fixtures();
    let a = fixtures.get("result-first-side");
    let b = fixtures.get("result-second-side");
    assert_ne!(a.id(&CRYPTO), b.id(&CRYPTO));
    assert_eq!(a.outcome_id(&CRYPTO), b.outcome_id(&CRYPTO));
    assert_eq!(
        a.subject().unwrap().to_bytes(),
        b.subject().unwrap().to_bytes()
    );
}

#[test]
fn every_bit_flip_breaks_decoding_or_the_signature() {
    let fixtures = fixtures();
    for name in ["match", "result-first-side", "grant-giving", "unknown-kind"] {
        let record = fixtures.get(name);
        let body = record.body();
        for bit in 0..body.len() * 8 {
            let mut flipped = body.to_vec();
            flipped[bit / 8] ^= 1 << (bit % 8);
            match Record::assemble(flipped, *record.signature()) {
                Err(_) => {}
                Ok(changed) => assert!(changed.verify(&CRYPTO).is_err(), "{name} bit {bit}"),
            }
        }
        for bit in 0..512 {
            let mut signature = *record.signature().as_bytes();
            signature[bit / 8] ^= 1 << (bit % 8);
            match Record::from_parts(body, &signature) {
                Err(_) => {}
                Ok(changed) => assert!(changed.verify(&CRYPTO).is_err(), "{name} sig bit {bit}"),
            }
        }
    }
}

fn with_header(record: &Record, key: u64, value: u64) -> Vec<u8> {
    let Value::Map(mut entries) = cbor::decode(record.body()).unwrap() else {
        unreachable!()
    };
    for entry in &mut entries {
        if entry.0 == key {
            entry.1 = Value::Uint(value);
        }
    }
    cbor::encode(&Value::Map(entries))
}

#[test]
fn changing_the_kind_or_environment_breaks_the_signature() {
    let fixtures = fixtures();
    let result = fixtures.get("result-first-side");
    // result -> ruling would need a different shape, so use an unknown
    // number, which still decodes, and every other environment.
    for kind in [999, Kind::Score.number()] {
        let body = with_header(result, 1, kind);
        if let Ok(changed) = Record::assemble(body, *result.signature()) {
            assert!(changed.verify(&CRYPTO).is_err());
        }
    }
    for environment in [Environment::PRODUCTION.0, Environment::DEVELOPMENT.0, 77] {
        let body = with_header(result, 2, environment);
        let changed = Record::assemble(body, *result.signature()).unwrap();
        assert!(changed.verify(&CRYPTO).is_err());
    }
    // Two kinds with the same fields: a release and a same-shaped unknown
    // kind. Relabelling decodes, and the signature refuses it (R4).
    let release = fixtures.get("release");
    let body = with_header(release, 1, 200);
    let relabelled = Record::assemble(body, *release.signature()).unwrap();
    assert!(relabelled.verify(&CRYPTO).is_err());
}

#[test]
fn strict_decoding_rejects_each_non_canonical_form() {
    let fixtures = fixtures();
    let alice = &fixtures.keys[0];
    let good = fixtures.get("hello").body().to_vec();
    let sig = *fixtures.get("hello").signature();

    // Format version written as 0x18 0x01.
    let mut long = good.clone();
    assert_eq!(&long[1..3], &[0x00, 0x01]);
    long.splice(2..3, [0x18, 0x01]);
    assert_eq!(
        Record::assemble(long, sig),
        Err(RecordError::Cbor(CborError::NotShortest))
    );

    let mut trailing = good.clone();
    trailing.push(0);
    assert_eq!(
        Record::assemble(trailing, sig),
        Err(RecordError::Cbor(CborError::TrailingBytes))
    );

    // The map head says one more entry than there is.
    let mut count = good.clone();
    count[0] += 1;
    assert!(Record::assemble(count, sig).is_err());

    // Keys out of order: swap kind (1) and environment (2) entries.
    let Value::Map(entries) = cbor::decode(&good).unwrap() else {
        unreachable!()
    };
    let mut out = vec![0xa0 + entries.len() as u8];
    for (key, value) in [0, 2, 1, 3, 4].map(|i| &entries[i]) {
        out.push(*key as u8);
        out.extend(cbor::encode(value));
    }
    assert_eq!(
        Record::assemble(out, sig),
        Err(RecordError::Cbor(CborError::KeysNotAscending))
    );

    // Missing, unexpected and malformed fields.
    let r = random(1);
    let cases: Vec<(Vec<u8>, RecordError)> = vec![
        (
            raw_body(
                alice,
                1,
                Kind::Hello.number(),
                ENV.0,
                r,
                vec![(8, Value::Uint(0))],
            ),
            RecordError::UnexpectedField(8),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Hello.number(),
                ENV.0,
                r,
                vec![(7, Value::Uint(0))],
            ),
            RecordError::UnexpectedField(7),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Hello.number(),
                ENV.0,
                r,
                vec![(6, Value::Bytes(vec![0; 8]))],
            ),
            RecordError::UnexpectedField(6),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Release.number(),
                ENV.0,
                r,
                vec![(8, Value::Bytes(vec![0; 32]))],
            ),
            RecordError::MissingField(6),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Release.number(),
                ENV.0,
                r,
                vec![(6, Value::Bytes(vec![0; 8]))],
            ),
            RecordError::MissingField(8),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Release.number(),
                ENV.0,
                r,
                vec![
                    (6, Value::Bytes(vec![0; 7])),
                    (8, Value::Bytes(vec![0; 32])),
                ],
            ),
            RecordError::BadField(6),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Release.number(),
                ENV.0,
                r,
                vec![
                    (6, Value::Bytes(vec![0; 8])),
                    (8, Value::Bytes(vec![0; 31])),
                ],
            ),
            RecordError::BadField(8),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Match.number(),
                ENV.0,
                r,
                vec![
                    (
                        8,
                        Value::Array(vec![
                            Value::Array(vec![]),
                            Value::Array(vec![Value::Bytes(vec![0; 32])]),
                        ]),
                    ),
                    (9, Value::Bytes(vec![])),
                ],
            ),
            RecordError::BadField(8),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Grant.number(),
                ENV.0,
                r,
                vec![
                    (6, Value::Bytes(vec![0; 8])),
                    (
                        8,
                        Value::Map(vec![
                            (0, Value::Bytes(vec![0; 32])),
                            (1, Value::Bytes(vec![0; 32])),
                            (4, Value::Bytes(vec![0; 8])),
                        ]),
                    ),
                    (9, Value::Uint(3)),
                ],
            ),
            RecordError::BadField(9),
        ),
        (
            raw_body(
                alice,
                1,
                Kind::Hello.number(),
                ENV.0,
                r,
                vec![(5, Value::Bytes(vec![]))],
            ),
            RecordError::BadField(5),
        ),
    ];
    for (body, error) in cases {
        let signature = alice.sign_body(&body);
        assert_eq!(Record::assemble(body, signature), Err(error));
    }

    // A signer that is not a compressed point.
    let mut uncompressed = good.clone();
    let at = good.windows(2).position(|w| w == [0x58, 33]).unwrap() + 2;
    uncompressed[at] = 0x04;
    assert_eq!(
        Record::assemble(uncompressed, sig),
        Err(RecordError::BadField(3))
    );

    // Text, floats and negative numbers are outside the profile.
    for bad_value in [vec![0x60], vec![0xf9, 0x3c, 0x00], vec![0x20]] {
        let mut body = vec![0xa6];
        body.extend(&good[1..]);
        body.push(0x08);
        body.extend(bad_value);
        assert!(matches!(
            Record::assemble(body, sig),
            Err(RecordError::Cbor(CborError::UnsupportedType(_)))
        ));
    }

    // Too large.
    let big = raw_body(
        alice,
        1,
        999,
        ENV.0,
        r,
        vec![(8, Value::Bytes(vec![0; MAX_BODY_LENGTH]))],
    );
    assert_eq!(Record::assemble(big, sig), Err(RecordError::TooLarge));
    assert_eq!(
        Draft::score(
            fixtures.get("match").match_id(&CRYPTO).unwrap(),
            0,
            vec![0; MAX_BODY_LENGTH],
            vec![]
        )
        .body(ENV, alice.public(), r, None),
        Err(DraftError::TooLarge)
    );
    assert_eq!(
        Draft::match_([vec![], vec![alice.own_player()]], vec![]),
        Err(DraftError::EmptySide)
    );
}

#[test]
fn stored_signatures_must_be_low_s() {
    let fixtures = fixtures();
    let record = fixtures.get("match");
    let high = common::high_s(record.signature());
    assert!(Record::from_parts(record.body(), &high).is_err());
    // Converting the same bytes as a platform signature normalises them.
    let converted = Signature::from_raw(&high).unwrap();
    assert_eq!(&converted, record.signature());
}

#[test]
fn self_check_refuses_faulty_signing_adapters() {
    // Section 4.5: wrong format, truncated output, wrong key.
    let fixtures = fixtures();
    let [alice, bob, ..] = &fixtures.keys;
    let body = Draft::hello()
        .body(ENV, alice.public(), [9; 8], None)
        .unwrap();

    // A DER signature handed over as raw bytes.
    let der = alice.sign_der(&body);
    assert!(Signature::from_raw(&der).is_err());
    // Raw bytes handed over as DER.
    assert!(Signature::from_der(&alice.sign_raw(&body)).is_err());
    // Truncated.
    assert!(Signature::from_der(&der[..der.len() - 1]).is_err());
    assert!(Signature::from_raw(&alice.sign_raw(&body)[..63]).is_err());
    // The wrong key.
    let wrong = Signature::from_der(&bob.sign_der(&body)).unwrap();
    assert_eq!(
        Record::assemble_verified(body.clone(), wrong, &CRYPTO),
        Err(AssembleError::BadSignature)
    );
    // Signed over different bytes.
    let other = Signature::from_der(&alice.sign_der(b"something else")).unwrap();
    assert_eq!(
        Record::assemble_verified(body.clone(), other, &CRYPTO),
        Err(AssembleError::BadSignature)
    );
    let good = Signature::from_der(&der).unwrap();
    assert!(Record::assemble_verified(body, good, &CRYPTO).is_ok());
}

#[test]
fn ids_are_what_the_design_says() {
    use sha2::{Digest, Sha256};
    let fixtures = fixtures();
    let alice = &fixtures.keys[0];
    let key = alice.public();

    let mut preimage = b"fortymm.account.v1\0".to_vec();
    preimage.extend(key.as_bytes());
    assert_eq!(
        key.account_id(&CRYPTO).as_bytes(),
        &Sha256::digest(&preimage)[..]
    );
    let mut preimage = b"fortymm.own-player.v1\0".to_vec();
    preimage.extend(key.as_bytes());
    assert_eq!(
        key.own_player_id(&CRYPTO).as_bytes(),
        &Sha256::digest(&preimage)[..]
    );
    assert_ne!(
        key.account_id(&CRYPTO).as_bytes(),
        key.own_player_id(&CRYPTO).as_bytes()
    );

    let player = fixtures.get("player");
    assert_eq!(
        player.extra_player_id(&CRYPTO).unwrap().as_bytes(),
        &Sha256::digest(player.body())[..]
    );
    let match_record = fixtures.get("match");
    assert_eq!(
        match_record.match_id(&CRYPTO).unwrap().as_bytes(),
        match_record.id(&CRYPTO).as_bytes()
    );
    assert_eq!(
        match_record.id(&CRYPTO).as_bytes(),
        &Sha256::digest(match_record.body())[..]
    );
    // The signature is not part of the record id.
    let resigned = Record::assemble(
        match_record.body().to_vec(),
        Signature::from_raw(&alice.sign_raw(match_record.body())).unwrap(),
    )
    .unwrap();
    assert_eq!(resigned.id(&CRYPTO), match_record.id(&CRYPTO));

    let result = fixtures.get("result-first-side");
    let subject = result.subject().unwrap();
    let mut preimage = b"fortymm.outcome.v1\0".to_vec();
    preimage.extend(subject.to_bytes());
    let outcome = result.outcome_id(&CRYPTO).unwrap();
    assert_eq!(outcome.as_bytes(), &Sha256::digest(&preimage)[..]);
    assert_eq!(outcome.tag().as_bytes(), &outcome.as_bytes()[..8]);
    // The subject's bytes are a slice of the record's body.
    let bytes = subject.to_bytes();
    assert!(result.body().windows(bytes.len()).any(|w| w == bytes));
    // A ruling with the same subject has the same outcome id.
    let carol = &fixtures.keys[2];
    let ruling = carol.commit(&Draft::ruling(subject.clone()), [3; 8], None);
    assert_eq!(ruling.outcome_id(&CRYPTO), Some(outcome));
    // Changing any part of the subject changes the outcome id.
    let mut changed = subject.clone();
    changed.content.push(0);
    assert_ne!(changed.outcome_id(&CRYPTO), outcome);
    let mut changed = subject.clone();
    changed.seen.push(outcome.tag());
    assert_ne!(changed.outcome_id(&CRYPTO), outcome);
}

#[test]
fn clock_reading_is_display_only() {
    let fixtures = fixtures();
    let record = fixtures.get("match-doubles-with-clock");
    assert_eq!(
        record.header().clock.unwrap().unix_millis(),
        1_794_355_200_000
    );
}

/// R2 at the profile level: random values encode and decode to themselves.
#[test]
fn profile_round_trips_random_values() {
    fn value(rng: &mut Rng, depth: usize) -> Value {
        match rng.below(if depth > 3 { 2 } else { 4 }) {
            0 => Value::Uint(match rng.below(5) {
                0 => rng.next() % 24,
                1 => rng.next() % 256,
                2 => rng.next() % 65_536,
                3 => rng.next() % (1 << 32),
                _ => rng.next(),
            }),
            1 => {
                let length = rng.below(40);
                Value::Bytes(rng.bytes(length))
            }
            2 => {
                let count = rng.below(5);
                Value::Array((0..count).map(|_| value(rng, depth + 1)).collect())
            }
            _ => {
                let count = rng.below(5);
                let mut key = 0;
                Value::Map(
                    (0..count)
                        .map(|_| {
                            key += 1 + rng.next() % 300;
                            (key, value(rng, depth + 1))
                        })
                        .collect(),
                )
            }
        }
    }
    let mut rng = Rng::new(42);
    for _ in 0..20_000 {
        let v = value(&mut rng, 0);
        let bytes = cbor::encode(&v);
        assert_eq!(cbor::decode(&bytes).unwrap(), v);
    }
}

/// R2: for any byte string, decoding fails or re-encodes to the identical
/// bytes. Random strings, and mutations of every fixture body.
#[test]
fn decoder_fuzzing() {
    let fixtures = fixtures();
    let bodies: Vec<Vec<u8>> = fixtures
        .records
        .iter()
        .map(|(_, r)| r.body().to_vec())
        .collect();
    let signature = *fixtures.get("hello").signature();
    let mut rng = Rng::new(7);
    let mut accepted = 0;
    let check = |bytes: Vec<u8>, accepted: &mut usize| {
        if let Ok(value) = cbor::decode(&bytes) {
            assert_eq!(cbor::encode(&value), bytes);
        }
        match Record::assemble(bytes.clone(), signature) {
            Ok(record) => {
                *accepted += 1;
                assert_eq!(record.body(), bytes.as_slice());
                assert_eq!(cbor::encode(&cbor::decode(&bytes).unwrap()), bytes);
            }
            // The strict decoder alone must catch every non-canonical body;
            // the re-encode guard behind it is never what refuses one.
            Err(error) => assert_ne!(error, RecordError::NotCanonical, "{bytes:02x?}"),
        }
    };
    for _ in 0..200_000 {
        let length = rng.below(64);
        check(rng.bytes(length), &mut accepted);
    }
    for _ in 0..300_000 {
        let mut bytes = bodies[rng.below(bodies.len())].clone();
        for _ in 0..1 + rng.below(3) {
            let at = rng.below(bytes.len());
            match rng.below(5) {
                0 => bytes[at] ^= 1 << rng.below(8),
                1 => bytes[at] = rng.next() as u8,
                2 => bytes.insert(at, rng.next() as u8),
                3 => {
                    bytes.remove(at);
                }
                _ => bytes.truncate(at),
            }
            if bytes.is_empty() {
                break;
            }
        }
        check(bytes, &mut accepted);
    }
    // Some mutations must survive decoding, or the fuzzing proves little.
    assert!(accepted > 1_000, "only {accepted} mutated bodies decoded");
}

#[test]
fn every_hand_made_non_canonical_integer_is_refused() {
    // Each integer and length in a body, rewritten one size longer.
    let fixtures = fixtures();
    let record = fixtures.get("grant-giving");
    let body = record.body();
    let mut refused = 0;
    // Walk the heads with a tiny parser of our own.
    let mut position = 0;
    while position < body.len() {
        let first = body[position];
        let info = first & 0x1f;
        let major = first >> 5;
        let (argument, size) = match info {
            0..=23 => (u64::from(info), 1),
            24 => (u64::from(body[position + 1]), 2),
            25 => (
                u64::from(u16::from_be_bytes([body[position + 1], body[position + 2]])),
                3,
            ),
            _ => unreachable!(),
        };
        let longer: Vec<u8> = match size {
            1 => vec![(major << 5) | 24, argument as u8],
            2 => {
                let mut v = vec![(major << 5) | 25];
                v.extend((argument as u16).to_be_bytes());
                v
            }
            _ => {
                let mut v = vec![(major << 5) | 26];
                v.extend((argument as u32).to_be_bytes());
                v
            }
        };
        let mut changed = body.to_vec();
        changed.splice(position..position + size, longer);
        assert_eq!(
            Record::assemble(changed, *record.signature()),
            Err(RecordError::Cbor(CborError::NotShortest))
        );
        refused += 1;
        position += size;
        if major == 2 {
            position += argument as usize;
        }
    }
    assert!(refused > 20);
}
