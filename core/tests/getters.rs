//! The getters: what a record says about its match and its players, and the
//! generated username of a player id. The other builds check the same answers
//! through the golden vectors.

mod common;

use common::{CRYPTO, TERMS, fixtures};
use fortymm_core::layout::username::{MAX_SUFFIX_LENGTH, SUFFIX_ALPHABET};
use fortymm_core::{PlayerId, Record};

/// Fixtures whose kind or format version this library does not interpret.
const NOT_INTERPRETED: [&str; 5] = [
    "unknown-kind",
    "name-not-interpreted",
    "future-format-version",
    "match-future-format-version",
    "player-future-format-version",
];

#[test]
fn a_match_gives_its_id_sides_terms_and_creator() {
    let fixtures = fixtures();
    let [alice, bob, ..] = &fixtures.keys;
    let record = fixtures.get("match");

    assert_eq!(
        record.match_id(&CRYPTO).unwrap().as_bytes(),
        record.id(&CRYPTO).as_bytes()
    );
    assert_eq!(
        record.sides().unwrap(),
        &[vec![alice.own_player()], vec![bob.own_player()]]
    );
    assert_eq!(record.terms().unwrap(), TERMS);
    assert_eq!(record.creator(), Some(alice.public()));
    assert_eq!(record.repeats_player(), Some(false));
}

#[test]
fn a_match_naming_a_player_more_than_once_is_reported_and_still_read() {
    let fixtures = fixtures();
    let [alice, bob, carol, _] = &fixtures.keys;
    let extra = fixtures.get("player").extra_player_id(&CRYPTO).unwrap();

    let both = fixtures.get("match-player-on-both-sides");
    assert_eq!(both.repeats_player(), Some(true));
    assert_eq!(
        both.sides().unwrap(),
        &[vec![alice.own_player()], vec![alice.own_player()]]
    );
    assert!(both.match_id(&CRYPTO).is_some());
    assert_eq!(both.creator(), Some(bob.public()));

    let one_side = fixtures.get("match-player-twice-on-one-side");
    assert_eq!(one_side.repeats_player(), Some(true));
    assert_eq!(
        one_side.sides().unwrap(),
        &[
            vec![bob.own_player(), extra, bob.own_player()],
            vec![carol.own_player()]
        ]
    );
    assert!(one_side.verify(&CRYPTO).is_ok());

    // Four different players: not a repeat.
    let doubles = fixtures.get("match-doubles-with-clock");
    assert_eq!(doubles.repeats_player(), Some(false));
}

#[test]
fn only_a_match_gives_match_facts() {
    for (name, record) in &fixtures().records {
        if record.sides().is_some() {
            assert!(name.starts_with("match"), "{name}");
            continue;
        }
        assert_eq!(record.match_id(&CRYPTO), None, "{name}");
        assert_eq!(record.terms(), None, "{name}");
        assert_eq!(record.repeats_player(), None, "{name}");
    }
}

#[test]
fn a_player_record_gives_the_player_it_creates_and_its_creator() {
    let fixtures = fixtures();
    let record = fixtures.get("player");
    assert_eq!(
        record.extra_player_id(&CRYPTO).unwrap().as_bytes(),
        record.id(&CRYPTO).as_bytes()
    );
    assert_eq!(record.creator(), Some(fixtures.keys[0].public()));
    for (name, other) in &fixtures.records {
        if *name != "player" {
            assert_eq!(other.extra_player_id(&CRYPTO), None, "{name}");
        }
    }
}

#[test]
fn a_hello_gives_the_key_it_introduces() {
    let fixtures = fixtures();
    assert_eq!(
        fixtures.get("hello").introduced_key(),
        Some(fixtures.keys[0].public())
    );
    for (name, other) in &fixtures.records {
        if *name != "hello" {
            assert_eq!(other.introduced_key(), None, "{name}");
        }
    }
}

#[test]
fn a_record_not_interpreted_gives_its_signer_and_nothing_else() {
    let fixtures = fixtures();
    for name in NOT_INTERPRETED {
        let record: &Record = fixtures.get(name);
        assert_eq!(record.match_id(&CRYPTO), None, "{name}");
        assert_eq!(record.sides(), None, "{name}");
        assert_eq!(record.terms(), None, "{name}");
        assert_eq!(record.repeats_player(), None, "{name}");
        assert_eq!(record.creator(), None, "{name}");
        assert_eq!(record.extra_player_id(&CRYPTO), None, "{name}");
        assert_eq!(record.introduced_key(), None, "{name}");
        // The signer, and so its account and own player, are still there.
        let signer = record.signer();
        assert_eq!(
            record.signer_account_id(&CRYPTO),
            signer.account_id(&CRYPTO)
        );
        assert_eq!(
            record.signer_own_player_id(&CRYPTO),
            signer.own_player_id(&CRYPTO)
        );
    }
}

fn ids() -> Vec<PlayerId> {
    let fixtures = fixtures();
    let mut ids: Vec<PlayerId> = fixtures.keys.iter().map(|k| k.own_player()).collect();
    ids.push(fixtures.get("player").extra_player_id(&CRYPTO).unwrap());
    ids.extend((0..=255u8).map(|b| PlayerId::from_bytes([b; 32])));
    ids
}

#[test]
fn a_username_is_adjective_animal_suffix_of_the_length_asked_without_vowels() {
    for id in ids() {
        for length in 4..=MAX_SUFFIX_LENGTH {
            let name = id.username(length).unwrap();
            let parts: Vec<&str> = name.split('-').collect();
            assert_eq!(parts.len(), 3, "{name}");
            let [adjective, animal, suffix] = [parts[0], parts[1], parts[2]];
            assert!(
                fortymm_core::layout::username::ADJECTIVES.contains(&adjective),
                "{name}"
            );
            assert!(
                fortymm_core::layout::username::ANIMALS.contains(&animal),
                "{name}"
            );
            assert_eq!(suffix.len(), length, "{name}");
            assert!(
                suffix.bytes().all(|c| SUFFIX_ALPHABET.contains(&c)),
                "{name}"
            );
            assert!(!suffix.contains(['a', 'e', 'i', 'o', 'u', 'y']), "{name}");
        }
    }
}

#[test]
fn a_username_depends_on_the_id_alone_and_a_longer_suffix_extends_a_shorter() {
    let ids = ids();
    for id in &ids {
        let short = id.username(4).unwrap();
        assert_eq!(
            PlayerId::from_bytes(*id.as_bytes()).username(4).unwrap(),
            short
        );
        assert!(id.username(5).unwrap().starts_with(&short));
    }
    // Different ids, different names (at the longest suffix, every id here).
    let mut names: Vec<String> = ids
        .iter()
        .map(|id| id.username(MAX_SUFFIX_LENGTH).unwrap())
        .collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), ids.len());
}

#[test]
fn a_suffix_shorter_than_four_or_longer_than_the_maximum_is_refused() {
    let id = PlayerId::from_bytes([7; 32]);
    for length in [0, 1, 2, 3, MAX_SUFFIX_LENGTH + 1, 1000] {
        assert!(id.username(length).is_err(), "{length}");
    }
    assert!(id.username(4).is_ok());
}
