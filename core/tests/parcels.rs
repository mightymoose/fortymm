//! Parcels: round trip, damage fuzzing, split and merge (design section 6.5).

mod common;

use std::collections::BTreeSet;

use common::{CRYPTO, ENV, Rng, fixtures};
use fortymm_core::layout::parcel::ALPHABET;
use fortymm_core::{Content, Damaged, Environment, Kind, Parcel, ParcelError, Record};

fn all_fixtures_parcel() -> Parcel {
    let fixtures = fixtures();
    Parcel::new(ENV, fixtures.records.into_iter().map(|(_, r)| r).collect()).unwrap()
}

fn agreed_result_parcel() -> Parcel {
    let fixtures = fixtures();
    Parcel::new(
        ENV,
        ["match", "result-first-side", "result-second-side"]
            .map(|name| fixtures.get(name).clone())
            .to_vec(),
    )
    .unwrap()
}

#[test]
fn round_trip() {
    for parcel in [all_fixtures_parcel(), agreed_result_parcel()] {
        let text = parcel.text();
        let back = Parcel::parse(&text).unwrap();
        assert_eq!(back, parcel);
        for (a, b) in back.records().iter().zip(parcel.records()) {
            assert_eq!(a.body(), b.body());
            assert_eq!(a.signature(), b.signature());
            assert!(a.verify(&CRYPTO).is_ok());
        }
        assert_eq!(
            Parcel::parse(&parcel.link("fortymm.example")).unwrap(),
            parcel
        );
        assert_eq!(Parcel::from_binary(&parcel.to_binary()).unwrap(), parcel);
        assert!(text.bytes().all(|c| ALPHABET.contains(&c)));
        // Repeated byte strings are stored once.
        let plain: usize = parcel.records().iter().map(|r| r.to_bytes().len()).sum();
        assert!(parcel.to_binary().len() < plain);
    }
}

#[test]
fn link_form() {
    let parcel = agreed_result_parcel();
    let link = parcel.link("fortymm.example");
    assert!(link.starts_with("HTTPS://FORTYMM.EXAMPLE/P/"));
    assert_eq!(Parcel::parse(&link.to_lowercase()).unwrap(), parcel);
    for bad in [
        format!("HTTP://FORTYMM.EXAMPLE/P/{}", parcel.text()),
        format!("HTTPS:///P/{}", parcel.text()),
        format!("HTTPS://FORTYMM.EXAMPLE/Q/{}", parcel.text()),
        format!("HTTPS://FORTYMM.EXAMPLE/P/{}?x", parcel.text()),
    ] {
        assert!(Parcel::parse(&bad).is_err(), "{bad}");
    }
}

#[test]
fn construction_rules() {
    let fixtures = fixtures();
    let record = fixtures.get("hello").clone();
    assert_eq!(Parcel::new(ENV, vec![]), Err(ParcelError::Empty));
    assert_eq!(
        Parcel::new(Environment::PRODUCTION, vec![record.clone()]),
        Err(ParcelError::Environment(0))
    );
    let other = fixtures.keys[0].commit_in(
        Environment::PRODUCTION,
        &fortymm_core::Draft::hello(),
        [0; 8],
        None,
    );
    assert_eq!(
        Parcel::new(ENV, vec![record, other]),
        Err(ParcelError::Environment(1))
    );
}

/// Any result of parsing damaged text: the original parcel, or `Damaged`.
fn judge(original: &Parcel, text: &str, counts: &mut [usize; 2]) {
    match Parcel::parse(text) {
        Ok(parcel) => {
            assert_eq!(
                &parcel, original,
                "damaged text parsed as another parcel: {text}"
            );
            counts[0] += 1;
        }
        Err(_) => counts[1] += 1,
    }
}

#[test]
fn every_single_character_change_is_detected() {
    // Exhaustive over a one-result parcel: every substitution, deletion,
    // insertion and truncation. None may parse.
    let fixtures = fixtures();
    let parcel = Parcel::new(
        ENV,
        vec![
            fixtures.get("match").clone(),
            fixtures.get("result-first-side").clone(),
        ],
    )
    .unwrap();
    let text = parcel.text();
    let chars: Vec<u8> = text.bytes().collect();
    let mut counts = [0usize; 2];
    for at in 0..chars.len() {
        for &c in ALPHABET {
            if c != chars[at] {
                let mut changed = chars.clone();
                changed[at] = c;
                judge(&parcel, std::str::from_utf8(&changed).unwrap(), &mut counts);
            }
        }
        let mut deleted = chars.clone();
        deleted.remove(at);
        judge(&parcel, std::str::from_utf8(&deleted).unwrap(), &mut counts);
        for &c in ALPHABET {
            let mut inserted = chars.clone();
            inserted.insert(at, c);
            judge(
                &parcel,
                std::str::from_utf8(&inserted).unwrap(),
                &mut counts,
            );
        }
        judge(&parcel, &text[..at], &mut counts);
    }
    for &c in ALPHABET {
        judge(&parcel, &format!("{text}{}", c as char), &mut counts);
    }
    assert_eq!(counts[0], 0, "a changed text parsed");
    println!(
        "single-character damage: {} variants, all rejected",
        counts[1]
    );
}

#[test]
fn case_and_whitespace_are_harmless() {
    let parcel = agreed_result_parcel();
    let text = parcel.text();
    let mut rng = Rng::new(11);
    for _ in 0..2_000 {
        let mut out = String::new();
        for c in text.chars() {
            if rng.below(30) == 0 {
                out.push([' ', '\n', '\r', '\t', '\u{a0}'][rng.below(5)]);
            }
            out.push(if rng.below(2) == 0 {
                c.to_ascii_lowercase()
            } else {
                c
            });
        }
        assert_eq!(Parcel::parse(&out).unwrap(), parcel);
    }
    // Line breaks every 40 characters, as a messaging app might insert.
    let wrapped: Vec<String> = text
        .as_bytes()
        .chunks(40)
        .map(|c| String::from_utf8(c.to_vec()).unwrap())
        .collect();
    assert_eq!(Parcel::parse(&wrapped.join("\r\n")).unwrap(), parcel);
}

#[test]
fn random_damage_never_yields_another_parcel() {
    let parcel = all_fixtures_parcel();
    let text: Vec<u8> = parcel.text().into_bytes();
    let mut rng = Rng::new(99);
    let mut counts = [0usize; 2];
    for _ in 0..100_000 {
        let mut damaged = text.clone();
        for _ in 0..1 + rng.below(6) {
            if damaged.len() < 2 {
                break;
            }
            let at = rng.below(damaged.len());
            match rng.below(5) {
                0 | 1 => damaged[at] = ALPHABET[rng.below(32)],
                2 => {
                    damaged.remove(at);
                }
                3 => damaged.insert(at, ALPHABET[rng.below(32)]),
                _ => damaged.truncate(at.max(1)),
            }
        }
        judge(&parcel, std::str::from_utf8(&damaged).unwrap(), &mut counts);
    }
    // Some random changes are no change at all (a character replaced by
    // itself); those parse to the original, which is allowed.
    assert!(counts[1] > 99_000);
}

#[test]
fn binary_damage_is_detected() {
    // Every single-bit flip and every byte change in the binary form.
    let parcel = agreed_result_parcel();
    let binary = parcel.to_binary();
    for bit in 0..binary.len() * 8 {
        let mut flipped = binary.clone();
        flipped[bit / 8] ^= 1 << (bit % 8);
        assert!(Parcel::from_binary(&flipped).is_err());
    }
    // Bursts of up to 32 bits anywhere are always caught by the checksum.
    let mut rng = Rng::new(5);
    for _ in 0..50_000 {
        let mut damaged = binary.clone();
        let start = rng.below(binary.len() * 8 - 32);
        let length = 1 + rng.below(32);
        let pattern = rng.next() | 1 | (1 << (length - 1));
        for i in 0..length {
            if pattern >> i & 1 == 1 {
                let bit = start + i;
                damaged[bit / 8] ^= 0x80 >> (bit % 8);
            }
        }
        assert_eq!(Parcel::from_binary(&damaged), Err(Damaged::Checksum));
    }
}

/// Wrap a container (everything between the version byte and the checksum)
/// as a binary parcel with a correct checksum.
fn sealed(version: u8, container: &[u8]) -> Vec<u8> {
    let mut out = vec![version];
    out.extend_from_slice(container);
    let sum = fortymm_core::parcel::checksum(&out);
    out.extend(sum.to_be_bytes());
    out
}

#[test]
fn non_canonical_binary_is_refused() {
    // A one-record parcel stores nothing once: no byte string repeats.
    let fixtures = fixtures();
    let record = fixtures.get("hello");
    let parcel = Parcel::new(ENV, vec![record.clone()]).unwrap();
    let mut container = vec![0x83, ENV.0 as u8, 0x80, 0x81, 0x82];
    container.extend(cbor_bytes_inline(record.body()));
    container.extend([0x58, 0x40]);
    container.extend(record.signature().as_bytes());
    // The hand-built container is exactly what the encoder writes.
    let binary = sealed(1, &container);
    assert_eq!(binary, parcel.to_binary());
    assert_eq!(Parcel::from_binary(&binary).unwrap(), parcel);

    // The same record with its signer stored once although it appears once:
    // a valid structure that decodes to the same parcel, refused because it
    // is not the one encoding.
    let key = record.header().signer.as_bytes().to_vec();
    let mut table_head = vec![0x81, 0x58, 0x21];
    table_head.extend(&key);
    let mut inline = vec![0x58, 0x21];
    inline.extend(&key);
    let body = cbor_bytes_inline(record.body());
    let at = body
        .windows(inline.len())
        .position(|w| w == inline)
        .unwrap();
    let mut referenced = body[..at].to_vec();
    referenced.push(0x20); // reference to table entry 0
    referenced.extend(&body[at + inline.len()..]);
    let mut container = vec![0x83, ENV.0 as u8];
    container.extend(&table_head);
    container.extend([0x81, 0x82]);
    container.extend(&referenced);
    container.extend([0x58, 0x40]);
    container.extend(record.signature().as_bytes());
    assert_eq!(
        Parcel::from_binary(&sealed(1, &container)),
        Err(Damaged::NotCanonical)
    );

    // A reference to a table entry that does not exist.
    let mut container = vec![0x83, ENV.0 as u8, 0x80, 0x81, 0x82];
    container.extend(&referenced);
    container.extend([0x58, 0x40]);
    container.extend(record.signature().as_bytes());
    assert!(matches!(
        Parcel::from_binary(&sealed(1, &container)),
        Err(Damaged::Container(_))
    ));

    // An unknown container version, and no records.
    assert_eq!(
        Parcel::from_binary(&sealed(2, &binary[1..binary.len() - 4])),
        Err(Damaged::ContainerVersion)
    );
    assert_eq!(
        Parcel::from_binary(&sealed(1, &[0x83, ENV.0 as u8, 0x80, 0x80])),
        Err(Damaged::Empty)
    );
    assert_eq!(Parcel::from_binary(&[1, 2, 3]), Err(Damaged::Short));
}

/// A record's body is written inside a parcel as the map itself, not as a
/// byte string; with no table, those bytes are the body unchanged.
fn cbor_bytes_inline(body: &[u8]) -> Vec<u8> {
    body.to_vec()
}

fn is_ordered(record: &Record) -> bool {
    record.kind().is_none_or(Kind::carries_stamp)
}

#[test]
fn split_and_merge() {
    let parcel = all_fixtures_parcel();
    let records = parcel.records();
    let ids: Vec<_> = records.iter().map(|r| r.id(&CRYPTO)).collect();
    let full = parcel.text().len();

    // A parcel that fits is returned unchanged.
    assert_eq!(parcel.split(full, &CRYPTO).unwrap(), vec![parcel.clone()]);

    println!("all fixtures: {full} characters");
    for max in [2_400, 3_000, 4_000, 6_000] {
        let parts = parcel.split(max, &CRYPTO).unwrap();
        assert!(parts.len() > 1 || max >= full);
        let mut seen = BTreeSet::new();
        for part in &parts {
            assert!(part.text().len() <= max);
            // Each part is a complete parcel on its own.
            assert_eq!(&Parcel::parse(&part.text()).unwrap(), part);
            // In the original order.
            let positions: Vec<usize> = part
                .records()
                .iter()
                .map(|r| ids.iter().position(|id| *id == r.id(&CRYPTO)).unwrap())
                .collect();
            assert!(positions.windows(2).all(|w| w[0] < w[1]));
            let present: BTreeSet<usize> = positions.iter().copied().collect();
            for &position in &positions {
                seen.insert(position);
                let record = &records[position];
                // Every earlier grant, request or unknown kind travels with it.
                for (earlier, before) in records[..position].iter().enumerate() {
                    if is_ordered(before) {
                        assert!(
                            present.contains(&earlier),
                            "max {max}: {earlier} before {position}"
                        );
                    }
                }
                // Its match, and the player records that created players it
                // names, travel with it.
                for id in record.content().referenced_ids() {
                    if let Some(creator) = ids.iter().position(|r| *r.as_bytes() == id)
                        && matches!(
                            records[creator].content(),
                            Content::Match { .. } | Content::Player
                        )
                    {
                        assert!(present.contains(&creator));
                    }
                }
            }
        }
        // Every record is somewhere.
        assert_eq!(seen.len(), records.len(), "max {max}");
    }

    // A size nothing fits in.
    assert!(parcel.split(100, &CRYPTO).is_err());
}

#[test]
fn split_without_ordered_records_needs_no_repeats() {
    // A backlog of matches, results and scores: no grants or requests, so no
    // record needs to appear twice except a match its results need.
    let fixtures = fixtures();
    let [alice, bob, ..] = &fixtures.keys;
    let mut records = Vec::new();
    for i in 0..10u8 {
        let m = alice.commit(
            &fortymm_core::Draft::match_(
                [vec![alice.own_player()], vec![bob.own_player()]],
                vec![i],
            )
            .unwrap(),
            [i; 8],
            None,
        );
        let id = m.match_id(&CRYPTO).unwrap();
        records.push(m);
        let subject = fortymm_core::Subject {
            match_id: id,
            seen: vec![],
            content: common::CONTENT.to_vec(),
        };
        records.push(alice.commit(
            &fortymm_core::Draft::result(subject.clone(), alice.own_player(), vec![]),
            [i; 8],
            None,
        ));
        records.push(bob.commit(
            &fortymm_core::Draft::result(subject, bob.own_player(), vec![]),
            [i; 8],
            None,
        ));
    }
    let parcel = Parcel::new(ENV, records).unwrap();
    let one = Parcel::new(ENV, parcel.records()[..3].to_vec())
        .unwrap()
        .text()
        .len();
    println!("one match with both signatures: {one} characters");
    let parts = parcel.split(2_000, &CRYPTO).unwrap();
    let total: usize = parts.iter().map(|p| p.records().len()).sum();
    assert_eq!(total, parcel.records().len());
    for part in &parts {
        // Each part holds whole matches: a result never travels without its match.
        assert_eq!(part.records().len() % 3, 0);
    }
    println!(
        "10 agreed results: {} characters as one parcel; {} parts at 2,000 characters",
        parcel.text().len(),
        parts.len()
    );
}
