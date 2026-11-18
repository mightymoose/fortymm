//! A match's state from its records (FORMAT.md section 16), through the
//! public interface. The golden vectors (`match_states` in vectors.json) hold
//! a correction and two clears, checked by every build; this file holds what
//! only the Rust build checks.

mod common;

use common::{CRYPTO, TERMS, TestKey, keys, random};
use fortymm_core::layout::match_state::MAX_GAME;
use fortymm_core::{Draft, MatchId, MatchState, Record, RecordId, ScoreValue, Terms, match_state};

const BEST_OF_5: fn() -> Terms = || Terms::new(5, true).unwrap();

fn points(first: u32, second: u32) -> Vec<u8> {
    ScoreValue::Points([first, second]).to_bytes()
}

fn cleared() -> Vec<u8> {
    ScoreValue::Cleared.to_bytes()
}

/// A match between alice and bob, signed by alice.
fn a_match(alice: &TestKey, bob: &TestKey, terms: Vec<u8>, seed: u8) -> Record {
    let sides = [vec![alice.own_player()], vec![bob.own_player()]];
    alice.commit(&Draft::match_(sides, terms).unwrap(), random(seed), None)
}

fn score(
    key: &TestKey,
    match_id: MatchId,
    slot: u64,
    value: Vec<u8>,
    replaces: &[&Record],
    seed: u8,
) -> Record {
    let replaces = replaces.iter().map(|r| r.id(&CRYPTO)).collect();
    key.commit(
        &Draft::score(match_id, slot, value, replaces),
        random(seed),
        None,
    )
}

fn id(record: &Record) -> RecordId {
    record.id(&CRYPTO)
}

fn match_id(record: &Record) -> MatchId {
    record.match_id(&CRYPTO).unwrap()
}

fn state(records: &[&Record]) -> Option<MatchState> {
    let records: Vec<Record> = records.iter().map(|r| (*r).clone()).collect();
    match_state(&records, &CRYPTO)
}

/// Every order of `items`, by Heap's algorithm.
fn each_permutation<T: Clone>(items: &[T], mut visit: impl FnMut(&[T])) {
    let mut items = items.to_vec();
    let mut counters = vec![0; items.len()];
    visit(&items);
    let mut i = 0;
    while i < items.len() {
        if counters[i] < i {
            let j = if i % 2 == 0 { 0 } else { counters[i] };
            items.swap(j, i);
            visit(&items);
            counters[i] += 1;
            i = 0;
        } else {
            counters[i] = 0;
            i += 1;
        }
    }
}

// C1. The same set of records gives the same state in any order, with
// repeats. The set holds a correction, a clear and a game with two current
// entries, so an answer that depended on order would show.
#[test]
fn every_order_of_the_records_with_repeats_gives_the_same_state() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let game_1 = score(&alice, m, 1, points(11, 9), &[], 2);
    let corrected = score(&alice, m, 1, points(11, 7), &[&game_1], 3);
    let game_2 = score(&bob, m, 2, points(9, 11), &[], 4);
    let cleared_2 = score(&bob, m, 2, cleared(), &[&game_2], 5);
    let game_3_alice = score(&alice, m, 3, points(11, 4), &[], 6);
    let game_3_bob = score(&bob, m, 3, points(4, 11), &[], 7);
    let records = [
        &match_,
        &game_1,
        &corrected,
        &game_2,
        &cleared_2,
        &game_3_alice,
        &game_3_bob,
        // Repeats.
        &game_1,
        &match_,
    ];

    let expected = state(&records).unwrap();
    let game_3 = [&game_3_alice, &game_3_bob]
        .into_iter()
        .max_by_key(|r| id(r))
        .unwrap();
    let game_3_score = if game_3 == &game_3_alice {
        [11, 4]
    } else {
        [4, 11]
    };
    assert_eq!(
        expected.games,
        vec![Some([11, 7]), None, Some(game_3_score)]
    );

    let mut orders = 0;
    each_permutation(&records, |order| {
        assert_eq!(state(order).as_ref(), Some(&expected), "order {orders}");
        orders += 1;
    });
    assert_eq!(orders, 362_880);
}

#[test]
fn the_state_gives_the_match_its_creator_sides_and_terms() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let got = state(&[&match_]).unwrap();
    assert_eq!(got.match_id, match_id(&match_));
    assert_eq!(got.creator, alice.public());
    assert_eq!(
        got.sides,
        [vec![alice.own_player()], vec![bob.own_player()]]
    );
    assert_eq!(got.terms, Some(BEST_OF_5()));
    assert_eq!(got.games, vec![]);
    assert_eq!(got.current, Vec::<Vec<RecordId>>::new());
}

#[test]
fn an_anonymous_side_shows_as_an_empty_list() {
    let [alice, ..] = keys();
    let sides = [vec![alice.own_player()], vec![]];
    let terms = Terms::new(3, false).unwrap();
    let match_ = alice.commit(
        &Draft::match_(sides.clone(), terms.to_bytes()).unwrap(),
        random(2),
        None,
    );
    let game_1 = score(&alice, match_id(&match_), 1, points(11, 6), &[], 3);
    let got = state(&[&match_, &game_1]).unwrap();
    assert_eq!(got.sides, sides);
    assert_eq!(got.terms, Some(terms));
    assert_eq!(got.games, vec![Some([11, 6])]);
}

// The creator is the key that signed the match record, whatever else the set
// holds. Here the match is a doubles match signed by carol, and a score
// signed by bob has the highest record id in the set, so neither the first
// player nor the signer of the highest-id record would pass.
#[test]
fn the_creator_is_the_signer_of_the_match_record() {
    let [alice, bob, carol, dave] = keys();
    let sides = [
        vec![alice.own_player(), carol.own_player()],
        vec![bob.own_player(), dave.own_player()],
    ];
    let terms = BEST_OF_5().to_bytes();
    let match_ = carol.commit(
        &Draft::match_(sides.clone(), terms).unwrap(),
        random(1),
        None,
    );
    let m = match_id(&match_);
    let game_1 = (2..=u8::MAX)
        .map(|seed| score(&bob, m, 1, points(11, 9), &[], seed))
        .find(|r| id(r) > id(&match_))
        .unwrap();

    let got = state(&[&game_1, &match_]).unwrap();
    assert_eq!(got.creator, carol.public());
    assert_eq!(got.sides, sides);
}

// A repeat is the same record id, not the same bytes. A record signed again
// (the same body, a signature with another nonce) is another valid copy of
// the same record, so it changes nothing: not the match record, which
// would otherwise look like a second match, and not a score, whose id
// would otherwise be current twice.
#[test]
fn a_re_signed_record_is_the_same_record() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let game_1 = score(&bob, m, 1, points(11, 9), &[], 2);
    let game_2 = score(&alice, m, 2, points(4, 11), &[], 3);
    let match_again = alice.re_sign(&match_, 1);
    let game_1_again = bob.re_sign(&game_1, 2);

    let expected = state(&[&match_, &game_1, &game_2]).unwrap();
    assert_eq!(expected.games, vec![Some([11, 9]), Some([4, 11])]);
    assert_eq!(expected.current, vec![vec![id(&game_1)], vec![id(&game_2)]]);
    let records = [&match_, &game_1, &game_2, &match_again, &game_1_again];
    let mut orders = 0;
    each_permutation(&records, |order| {
        assert_eq!(state(order).as_ref(), Some(&expected), "order {orders}");
        orders += 1;
    });
    assert_eq!(orders, 120);
    // Only the copies, without the first signatures.
    assert_eq!(
        state(&[&game_2, &game_1_again, &match_again]),
        Some(expected)
    );
}

// C5. With no match record there is no state.
#[test]
fn without_a_match_record_there_is_no_state() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let game_1 = score(&alice, match_id(&match_), 1, points(11, 9), &[], 2);
    assert_eq!(state(&[&game_1]), None);
    assert_eq!(state(&[]), None);
}

// C5. Scores of another match are ignored, as is a score of another match
// that names one of this match's entries as replaced.
#[test]
fn scores_of_another_match_are_ignored() {
    let [alice, bob, carol, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let other = a_match(&alice, &carol, BEST_OF_5().to_bytes(), 2);
    let game_1 = score(&alice, match_id(&match_), 1, points(11, 9), &[], 3);
    let other_game_2 = score(&alice, match_id(&other), 2, points(11, 1), &[], 4);
    let other_replacing = score(&alice, match_id(&other), 1, points(11, 2), &[&game_1], 5);

    let got = state(&[&match_, &game_1, &other_game_2, &other_replacing]).unwrap();
    assert_eq!(got.games, vec![Some([11, 9])]);
    assert_eq!(got.current, vec![vec![id(&game_1)]]);
}

// C5. A score with slot 0 is a valid record, but slot 0 has no value
// layout and is no game, so the state ignores it.
#[test]
fn a_score_for_the_whole_match_is_ignored() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let whole = score(&alice, match_id(&match_), 0, points(3, 1), &[], 2);
    let got = state(&[&match_, &whole]).unwrap();
    assert_eq!(got.games, vec![]);
    assert_eq!(got.current, Vec::<Vec<RecordId>>::new());
}

// A slot-0 score's replaces list replaces nothing, in any game: slot 0 is no
// game, so it has no entries of its own game to replace.
#[test]
fn a_slot_0_score_replaces_nothing() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let game_1 = score(&alice, m, 1, points(11, 9), &[], 2);
    let game_2 = score(&bob, m, 2, points(4, 11), &[], 3);
    let whole = score(&bob, m, 0, cleared(), &[&game_1, &game_2], 4);

    let got = state(&[&match_, &game_1, &game_2, &whole]).unwrap();
    assert_eq!(got.games, vec![Some([11, 9]), Some([4, 11])]);
    assert_eq!(got.current, vec![vec![id(&game_1)], vec![id(&game_2)]]);
}

// A chain of corrections, a <- b <- c <- d, leaves only d current, whatever
// the ids: each link is replaced by the next, even though the next is itself
// replaced.
#[test]
fn a_chain_of_corrections_leaves_only_the_last_current() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let a = score(&alice, m, 1, points(11, 9), &[], 2);
    let b = score(&alice, m, 1, points(11, 8), &[&a], 3);
    let c = score(&bob, m, 1, points(11, 7), &[&b], 4);
    let d = score(&alice, m, 1, points(11, 6), &[&c], 5);
    let e = score(&bob, m, 1, points(11, 5), &[&d], 6);

    for (chain, last) in [(vec![&a, &b, &c, &d], &d), (vec![&a, &b, &c, &d, &e], &e)] {
        let mut records = vec![&match_];
        records.extend(&chain);
        let got = state(&records).unwrap();
        assert_eq!(
            got.current,
            vec![vec![id(last)]],
            "chain of {}",
            chain.len()
        );
        let ScoreValue::Points(shown) = ScoreValue::read(last.value().unwrap()).unwrap() else {
            unreachable!()
        };
        assert_eq!(got.games, vec![Some(shown)], "chain of {}", chain.len());
    }
}

// A branch: b and c both correct a, on two devices, so both are current;
// then d, made after both were seen, replaces both and is current alone.
#[test]
fn a_branch_is_current_on_both_sides_until_one_score_replaces_both() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let a = score(&alice, m, 1, points(11, 9), &[], 2);
    let b = score(&alice, m, 1, points(11, 8), &[&a], 3);
    let c = score(&bob, m, 1, points(11, 7), &[&a], 4);
    let mut both = vec![id(&b), id(&c)];
    both.sort();

    let got = state(&[&match_, &a, &b, &c]).unwrap();
    assert_eq!(got.current, vec![both]);

    let d = score(&bob, m, 1, points(11, 6), &[&b, &c], 5);
    let got = state(&[&match_, &a, &b, &c, &d]).unwrap();
    assert_eq!(got.current, vec![vec![id(&d)]]);
    assert_eq!(got.games, vec![Some([11, 6])]);

    // A score that replaces only one side leaves the other current.
    let e = score(&alice, m, 1, points(11, 5), &[&b], 6);
    let mut rest = vec![id(&c), id(&e)];
    rest.sort();
    let got = state(&[&match_, &a, &b, &c, &e]).unwrap();
    assert_eq!(got.current, vec![rest]);
}

// C3. Several games cleared at the end leave no empty game trailing, and
// their clearing entries stay current.
#[test]
fn several_games_cleared_at_the_end_leave_no_trailing_empty_game() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let game_1 = score(&alice, m, 1, points(11, 9), &[], 2);
    let game_2 = score(&alice, m, 2, points(11, 8), &[], 3);
    let game_3 = score(&bob, m, 3, points(7, 11), &[], 4);
    let game_4 = score(&bob, m, 4, points(6, 11), &[], 5);
    let cleared_2 = score(&alice, m, 2, cleared(), &[&game_2], 6);
    let cleared_3 = score(&alice, m, 3, cleared(), &[&game_3], 7);
    let cleared_4 = score(&bob, m, 4, cleared(), &[&game_4], 8);

    let got = state(&[
        &match_, &game_1, &game_2, &game_3, &game_4, &cleared_2, &cleared_3, &cleared_4,
    ])
    .unwrap();
    assert_eq!(got.games, vec![Some([11, 9])]);
    assert_eq!(
        got.current,
        vec![
            vec![id(&game_1)],
            vec![id(&cleared_2)],
            vec![id(&cleared_3)],
            vec![id(&cleared_4)]
        ]
    );
}

// The cap is 255 games, by number (FORMAT.md section 16), not merely
// whatever MAX_GAME is: with terms it can't read, a score for game 255
// shows and one for game 256 is ignored.
#[test]
fn without_terms_games_stop_at_255() {
    assert_eq!(MAX_GAME, 255);
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, TERMS.to_vec(), 1);
    let m = match_id(&match_);
    let game_255 = score(&alice, m, 255, points(11, 9), &[], 2);
    let game_256 = score(&alice, m, 256, points(11, 8), &[], 3);

    let got = state(&[&match_, &game_255, &game_256]).unwrap();
    assert_eq!(got.games.len(), 255);
    assert_eq!(got.games[254], Some([11, 9]));
    assert_eq!(got.current.len(), 255);
    assert_eq!(got.current[254], vec![id(&game_255)]);

    let got = state(&[&match_, &game_256]).unwrap();
    assert_eq!(got.games, vec![]);
    assert_eq!(got.current, Vec::<Vec<RecordId>>::new());
}

// C5. Records of kinds it doesn't use are ignored.
#[test]
fn records_of_other_kinds_are_ignored() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let game_1 = score(&alice, match_id(&match_), 1, points(11, 9), &[], 2);
    let hello = alice.commit(&Draft::hello(), random(3), None);
    let player = alice.commit(&Draft::player(), random(4), None);
    let close = alice.commit(
        &Draft::close_match(match_id(&match_), None),
        random(5),
        None,
    );

    let alone = state(&[&match_, &game_1]).unwrap();
    assert_eq!(
        state(&[&hello, &match_, &player, &game_1, &close]),
        Some(alone)
    );
}

// C6. Several current entries for one game give one score, the same every
// time: the highest record id's. A placeholder (FORMAT.md section 16), so
// no golden vector.
#[test]
fn several_current_entries_for_one_game_show_the_highest_record_ids() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let entries = [
        score(&alice, m, 1, points(11, 3), &[], 2),
        score(&bob, m, 1, points(3, 11), &[], 3),
        score(&alice, m, 1, points(12, 10), &[], 4),
    ];
    let highest = entries.iter().max_by_key(|r| id(r)).unwrap();
    let ScoreValue::Points(shown) = ScoreValue::read(highest.value().unwrap()).unwrap() else {
        unreachable!()
    };
    let mut ids: Vec<RecordId> = entries.iter().map(id).collect();
    ids.sort();

    each_permutation(&entries.iter().collect::<Vec<_>>(), |order| {
        let mut records = vec![&match_];
        records.extend(order);
        let got = state(&records).unwrap();
        assert_eq!(got.games, vec![Some(shown)]);
        assert_eq!(got.current, vec![ids.clone()]);
    });
}

// C7. A match whose terms it can't read still has a state, with no terms:
// terms of layout version 2 (the bytes of version 1, best of 5, rated, with
// the version changed).
#[test]
fn a_match_with_terms_it_cannot_read_has_a_state_without_terms() {
    let [alice, bob, ..] = keys();
    let version_2 = vec![0xa3, 0x00, 0x02, 0x01, 0x05, 0x02, 0x01];
    assert_eq!(Terms::read(&version_2), None);
    let match_ = a_match(&alice, &bob, version_2, 1);
    let m = match_id(&match_);
    let game_1 = score(&alice, m, 1, points(11, 9), &[], 2);
    let game_2 = score(&bob, m, 2, points(5, 11), &[], 3);

    let got = state(&[&match_, &game_1, &game_2]).unwrap();
    assert_eq!(got.terms, None);
    assert_eq!(
        got.sides,
        [vec![alice.own_player()], vec![bob.own_player()]]
    );
    assert_eq!(got.games, vec![Some([11, 9]), Some([5, 11])]);
    assert_eq!(got.current, vec![vec![id(&game_1)], vec![id(&game_2)]]);
}

// The test fixtures' stand-in terms read as no terms too, so a state made
// from them has none.
#[test]
fn the_fixtures_stand_in_terms_read_as_no_terms() {
    let [alice, bob, ..] = keys();
    assert_eq!(Terms::read(&TERMS), None);
    let match_ = a_match(&alice, &bob, TERMS.to_vec(), 1);
    assert_eq!(state(&[&match_]).unwrap().terms, None);
}

// A value this build doesn't read gives no score, as a cleared one does, and
// the entry is still current.
#[test]
fn a_value_it_cannot_read_gives_no_score_and_stays_current() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let game_1 = score(&alice, m, 1, points(11, 9), &[], 2);
    // Layout version 2 of a score value, and bytes that are no value at all.
    let version_2 = score(
        &alice,
        m,
        2,
        vec![0xa2, 0x00, 0x02, 0x01, 0x82, 0x0b, 0x09],
        &[],
        3,
    );
    let damaged = score(&alice, m, 3, vec![0xff], &[], 4);
    let game_4 = score(&alice, m, 4, points(11, 6), &[], 5);

    let got = state(&[&match_, &game_1, &version_2, &damaged, &game_4]).unwrap();
    assert_eq!(got.games, vec![Some([11, 9]), None, None, Some([11, 6])]);
    assert_eq!(
        got.current,
        vec![
            vec![id(&game_1)],
            vec![id(&version_2)],
            vec![id(&damaged)],
            vec![id(&game_4)]
        ]
    );
}

// A replaced id that isn't in the set changes nothing.
#[test]
fn replacing_a_record_not_in_the_set_changes_nothing() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let missing = score(&alice, m, 1, points(11, 9), &[], 2);
    let corrected = score(&alice, m, 1, points(11, 7), &[&missing], 3);

    let got = state(&[&match_, &corrected]).unwrap();
    assert_eq!(got.games, vec![Some([11, 7])]);
    assert_eq!(got.current, vec![vec![id(&corrected)]]);
}

// A score replaces only entries of its own game: a game-2 score that lists
// a game-1 entry changes nothing for game 1. A score listing entries of two
// games replaces only the one of its own game.
#[test]
fn a_score_replaces_only_entries_of_its_own_game() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let m = match_id(&match_);
    let game_1 = score(&alice, m, 1, points(11, 9), &[], 2);
    let game_2 = score(&alice, m, 2, points(11, 5), &[], 3);
    let game_3 = score(&bob, m, 3, points(11, 8), &[&game_1, &game_2], 4);

    let got = state(&[&match_, &game_1, &game_2, &game_3]).unwrap();
    assert_eq!(got.games, vec![Some([11, 9]), Some([11, 5]), Some([11, 8])]);
    assert_eq!(
        got.current,
        vec![vec![id(&game_1)], vec![id(&game_2)], vec![id(&game_3)]]
    );

    let corrected_2 = score(&bob, m, 2, points(11, 6), &[&game_1, &game_2], 5);
    let got = state(&[&match_, &game_1, &game_2, &corrected_2]).unwrap();
    assert_eq!(got.games, vec![Some([11, 9]), Some([11, 6])]);
    assert_eq!(got.current, vec![vec![id(&game_1)], vec![id(&corrected_2)]]);
}

// Games past best of are ignored: records can come from other devices, which
// may have let one through. A best of 3 with a game-5 score shows games 1 to 3
// only, in `games` and in `current`.
#[test]
fn games_past_best_of_are_ignored() {
    let [alice, bob, ..] = keys();
    let best_of_3 = Terms::new(3, false).unwrap();
    let match_ = a_match(&alice, &bob, best_of_3.to_bytes(), 1);
    let m = match_id(&match_);
    let game_1 = score(&alice, m, 1, points(11, 9), &[], 2);
    let game_3 = score(&alice, m, 3, points(7, 11), &[], 3);
    let game_4 = score(&bob, m, 4, points(11, 2), &[], 4);
    let game_5 = score(&bob, m, 5, points(11, 3), &[], 5);

    let got = state(&[&match_, &game_1, &game_3, &game_4, &game_5]).unwrap();
    assert_eq!(got.terms, Some(best_of_3));
    assert_eq!(got.games, vec![Some([11, 9]), None, Some([7, 11])]);
    assert_eq!(
        got.current,
        vec![vec![id(&game_1)], vec![], vec![id(&game_3)]]
    );

    // With only games past best of, there are no games at all.
    let got = state(&[&match_, &game_5]).unwrap();
    assert_eq!(got.games, vec![]);
    assert_eq!(got.current, Vec::<Vec<RecordId>>::new());
}

// The records are about one match. Match records of two matches give no
// state: neither can be chosen without a rule.
#[test]
fn match_records_of_two_matches_give_no_state() {
    let [alice, bob, carol, ..] = keys();
    let match_ = a_match(&alice, &bob, BEST_OF_5().to_bytes(), 1);
    let other = a_match(&alice, &carol, BEST_OF_5().to_bytes(), 2);
    assert_eq!(state(&[&match_, &other]), None);
}

// Without terms it can read, there is no best of to stop at: a game past the
// last one a slot may name is ignored, so a record can't make a state of
// millions of empty games.
#[test]
fn without_terms_a_slot_past_the_last_game_is_ignored() {
    let [alice, bob, ..] = keys();
    let match_ = a_match(&alice, &bob, TERMS.to_vec(), 1);
    let m = match_id(&match_);
    let last = score(&alice, m, MAX_GAME, points(11, 9), &[], 2);
    let past = score(&alice, m, MAX_GAME + 1, points(11, 9), &[], 3);
    let far = score(&alice, m, u64::MAX, points(11, 9), &[], 4);

    let got = state(&[&match_, &last, &past, &far]).unwrap();
    assert_eq!(got.games.len() as u64, MAX_GAME);
    assert_eq!(got.current.len() as u64, MAX_GAME);
    assert_eq!(got.games.last(), Some(&Some([11, 9])));
}

// A best of above the last game a slot may name stops at that game, so terms
// can't make a state of millions of empty games either.
#[test]
fn a_best_of_past_the_last_game_stops_at_the_last_game() {
    let [alice, bob, ..] = keys();
    let terms = Terms::new(1_001, true).unwrap();
    let match_ = a_match(&alice, &bob, terms.to_bytes(), 1);
    let m = match_id(&match_);
    let last = score(&alice, m, MAX_GAME, points(11, 9), &[], 2);
    let past = score(&alice, m, MAX_GAME + 1, points(11, 9), &[], 3);

    let got = state(&[&match_, &last, &past]).unwrap();
    assert_eq!(got.games.len() as u64, MAX_GAME);
    assert_eq!(got.current.len() as u64, MAX_GAME);
}
