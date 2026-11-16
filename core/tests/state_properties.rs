//! A match's state (FORMAT.md section 16) checked against its rules over
//! many generated sets of records. Each set is a match and scores across
//! several games: corrections, chains, branches, clears, values that don't
//! read, slot 0, games past best of and past 255, replaced ids not in the
//! set, other matches' scores (some naming this match's entries) and records
//! of other kinds. The match is singles or doubles, signed by any of four
//! keys, and its scores by any of them. For each set the state is checked
//! against the rules, and against itself in shuffled orders with repeats,
//! some of them the same record signed again (same body, another signature).
//!
//! The generator is a seeded SplitMix64 (`common::Rng`), so every run checks
//! the same sets, and a failure names its seed.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{CRYPTO, Rng, TestKey, keys};
use fortymm_core::{
    Draft, MatchId, MatchState, PlayerId, PublicKey, Record, RecordId, ScoreValue, Terms,
    match_state,
};

/// How many sets are generated, and how many orders of each are checked.
const SETS: u64 = 2_000;
const ORDERS: usize = 12;

/// The last game a state can show (FORMAT.md section 16), written from the
/// rule, not from the code: best of when the terms read, capped at 255, and
/// 255 when they don't.
fn last_game(terms: Option<Terms>) -> u64 {
    terms.map_or(255, |t| u64::from(t.best_of()).min(255))
}

struct Score {
    id: RecordId,
    slot: u64,
    value: Vec<u8>,
    replaces: Vec<RecordId>,
}

fn value(rng: &mut Rng) -> Vec<u8> {
    match rng.below(8) {
        0 | 1 => ScoreValue::Cleared.to_bytes(),
        // A value of layout version 2, and bytes that are no value.
        2 => vec![0xa2, 0x00, 0x02, 0x01, 0x82, 0x0b, 0x09],
        3 => vec![0xff],
        4 => ScoreValue::Points([rng.next() as u32, rng.next() as u32]).to_bytes(),
        _ => ScoreValue::Points([rng.below(15) as u32, rng.below(15) as u32]).to_bytes(),
    }
}

fn slot(rng: &mut Rng, best_of: u64) -> u64 {
    match rng.below(20) {
        0 => 0,
        1 => [255, 256, u64::MAX][rng.below(3)],
        // Up to two games past best of.
        _ => 1 + rng.below(best_of as usize + 2) as u64,
    }
}

/// One generated set: the match record, everything else, and the match's
/// scores as the rules see them.
struct Case {
    match_: Record,
    creator: PublicKey,
    sides: [Vec<PlayerId>; 2],
    others: Vec<Record>,
    other_match: Record,
    terms: Option<Terms>,
    scores: Vec<Score>,
}

fn generate(rng: &mut Rng, keys: &[TestKey; 4]) -> Case {
    let [alice, bob, carol, dave] = keys;
    let key = |rng: &mut Rng| [alice, bob, carol, dave][rng.below(4)];
    // Singles or doubles, the players in any order, and the match signed by
    // any key, a player or not.
    let mut players = [alice, bob, carol, dave].map(TestKey::own_player).to_vec();
    for i in (1..players.len()).rev() {
        players.swap(i, rng.below(i + 1));
    }
    let per_side = 1 + rng.below(2);
    let sides = [
        players[..per_side].to_vec(),
        players[per_side..2 * per_side].to_vec(),
    ];
    let creator = key(rng);

    let (terms_bytes, terms) = match rng.below(5) {
        // Terms of layout version 2: they don't read.
        0 => (vec![0xa3, 0x00, 0x02, 0x01, 0x05, 0x02, 0x01], None),
        _ => {
            let t = Terms::new([1, 3, 5, 7][rng.below(4)], rng.below(2) == 0).unwrap();
            (t.to_bytes(), Some(t))
        }
    };
    let match_ = creator.commit(
        &Draft::match_(sides.clone(), terms_bytes).unwrap(),
        rng.array8(),
        None,
    );
    let m = match_.match_id(&CRYPTO).unwrap();
    let other_match = carol.commit(
        &Draft::match_(sides.clone(), Terms::new(3, true).unwrap().to_bytes()).unwrap(),
        rng.array8(),
        None,
    );
    let o = other_match.match_id(&CRYPTO).unwrap();
    let best_of = terms.map_or(5, |t| u64::from(t.best_of()));

    let mut scores: Vec<Score> = Vec::new();
    let mut others = Vec::new();
    for _ in 0..rng.below(14) {
        let slot = slot(rng, best_of);
        // Replace each earlier score with some chance, more likely in the
        // same game, so chains and branches form; sometimes name an id that
        // isn't in the set.
        let mut replaces = Vec::new();
        for earlier in &scores {
            let odds = if earlier.slot == slot { 2 } else { 8 };
            if rng.below(odds) == 0 {
                replaces.push(earlier.id);
            }
        }
        if rng.below(10) == 0 {
            replaces.push(RecordId::from_bytes(rng.bytes(32).try_into().unwrap()));
        }
        let value = value(rng);
        let record = key(rng).commit(
            &Draft::score(m, slot, value.clone(), replaces.clone()),
            rng.array8(),
            None,
        );
        scores.push(Score {
            id: record.id(&CRYPTO),
            slot,
            value,
            replaces,
        });
        others.push(record);
    }
    // Another match's scores, some naming this match's entries.
    for _ in 0..rng.below(3) {
        let replaces: Vec<RecordId> = scores
            .iter()
            .filter(|_| rng.below(2) == 0)
            .map(|s| s.id)
            .collect();
        let slot = 1 + rng.below(3) as u64;
        others.push(key(rng).commit(
            &Draft::score(o, slot, value(rng), replaces),
            rng.array8(),
            None,
        ));
    }
    // Records of other kinds.
    if rng.below(3) == 0 {
        others.push(key(rng).commit(&Draft::hello(), rng.array8(), None));
    }
    if rng.below(3) == 0 {
        others.push(key(rng).commit(&Draft::close_match(m, None), rng.array8(), None));
    }
    Case {
        match_,
        creator: creator.public(),
        sides,
        others,
        other_match,
        terms,
        scores,
    }
}

/// The set in a random order, with some records repeated: the same bytes,
/// or the same record signed again by its signer (same body and id, another
/// signature).
fn shuffled(rng: &mut Rng, keys: &[TestKey; 4], records: &[Record]) -> Vec<Record> {
    let mut out = records.to_vec();
    for _ in 0..rng.below(4) {
        if !records.is_empty() {
            let record = &records[rng.below(records.len())];
            out.push(if rng.below(2) == 0 {
                record.clone()
            } else {
                let signer = keys.iter().find(|k| k.public() == record.signer()).unwrap();
                signer.re_sign(record, rng.next())
            });
        }
    }
    for i in (1..out.len()).rev() {
        out.swap(i, rng.below(i + 1));
    }
    out
}

/// Every rule of FORMAT.md section 16 that `state` must keep for `case`.
fn check(case: &Case, state: &MatchState, seed: u64) {
    let m: MatchId = case.match_.match_id(&CRYPTO).unwrap();
    assert_eq!(state.match_id, m, "seed {seed}");
    // The creator is the match record's signer, whatever signed the rest.
    assert_eq!(state.creator, case.creator, "seed {seed}: creator");
    assert_eq!(state.sides, case.sides, "seed {seed}: sides");
    assert_eq!(state.terms, case.terms, "seed {seed}");
    let last = last_game(case.terms);

    // Each game's current entries, from the rule: a score of this match for
    // game n, 1 <= n <= last, that no score of this match for game n lists.
    let by_id: BTreeMap<RecordId, &Score> = case.scores.iter().map(|s| (s.id, s)).collect();
    let replaced_in = |game: u64, id: RecordId| {
        by_id
            .values()
            .any(|s| s.slot == game && s.replaces.contains(&id))
    };
    let mut expected: BTreeMap<u64, BTreeSet<RecordId>> = BTreeMap::new();
    for s in by_id.values() {
        if (1..=last).contains(&s.slot) && !replaced_in(s.slot, s.id) {
            expected.entry(s.slot).or_default().insert(s.id);
        }
    }

    // `current`: runs to the last game with a current entry and no further,
    // never past the last game; each id is a score of this match for that
    // game that no same-game score replaces; none is missing; lowest first,
    // no repeats.
    let runs_to = expected.keys().next_back().copied().unwrap_or(0);
    assert_eq!(
        state.current.len() as u64,
        runs_to,
        "seed {seed}: current's length"
    );
    assert!(state.current.len() as u64 <= last, "seed {seed}");
    for (index, ids) in state.current.iter().enumerate() {
        let game = index as u64 + 1;
        for id in ids {
            let s = by_id
                .get(id)
                .unwrap_or_else(|| panic!("seed {seed}: {id:?} is no score of the match"));
            assert_eq!(s.slot, game, "seed {seed}: an id in another game's current");
            assert!(
                !replaced_in(game, *id),
                "seed {seed}: a replaced id in current"
            );
        }
        assert!(
            ids.windows(2).all(|w| w[0] < w[1]),
            "seed {seed}: not lowest first"
        );
        let want: Vec<RecordId> = expected.get(&game).into_iter().flatten().copied().collect();
        assert_eq!(ids, &want, "seed {seed}: game {game}'s current entries");
    }

    // `games`: no trailing null, never past the last game, nor past
    // `current`; a game is null exactly when it has no current entry or the
    // shown entry (the highest id, the placeholder) is cleared or doesn't
    // read.
    assert_ne!(
        state.games.last(),
        Some(&None),
        "seed {seed}: a trailing null"
    );
    assert!(state.games.len() as u64 <= last, "seed {seed}");
    assert!(state.games.len() <= state.current.len(), "seed {seed}");
    for (index, ids) in state.current.iter().enumerate() {
        let shown = ids
            .last()
            .and_then(|id| match ScoreValue::read(&by_id[id].value) {
                Some(ScoreValue::Points(points)) => Some(points),
                _ => None,
            });
        let got = state.games.get(index).copied().flatten();
        assert_eq!(got, shown, "seed {seed}: game {}", index + 1);
    }
}

#[test]
fn every_generated_set_keeps_the_rules_in_every_order() {
    let keys = keys();
    let mut checked_orders = 0;
    let mut reached = Reached::default();
    for seed in 0..SETS {
        let mut rng = Rng::new(seed);
        let case = generate(&mut rng, &keys);
        let mut set = vec![case.match_.clone()];
        set.extend(case.others.iter().cloned());

        let state = match_state(&set, &CRYPTO).unwrap_or_else(|| panic!("seed {seed}: no state"));
        check(&case, &state, seed);
        for _ in 0..ORDERS {
            let order = shuffled(&mut rng, &keys, &set);
            reached.note_order(&set, &order);
            assert_eq!(
                match_state(&order, &CRYPTO).as_ref(),
                Some(&state),
                "seed {seed}: order"
            );
            checked_orders += 1;
        }

        reached.note(&case, &state);

        // Another match's `match` record in the set means no state.
        set.push(case.other_match.clone());
        assert_eq!(
            match_state(&shuffled(&mut rng, &keys, &set), &CRYPTO),
            None,
            "seed {seed}"
        );
    }
    assert_eq!(checked_orders, SETS as usize * ORDERS);
    println!("{SETS} sets, {checked_orders} orders; reached {reached:?}");
    reached.assert_all();
}

/// How many sets reached each shape the rules care about, so a generator
/// that stopped making one fails the test instead of passing quietly.
#[derive(Debug, Default)]
struct Reached {
    chain_of_3: u32,
    branch: u32,
    several_current: u32,
    slot_0_replacing: u32,
    past_the_last_game: u32,
    past_255: u32,
    no_terms: u32,
    two_trailing_empty: u32,
    other_match_replacing: u32,
    doubles: u32,
    creator_not_highest_id: u32,
    re_signed_match: u32,
    re_signed_score: u32,
}

impl Reached {
    fn note(&mut self, case: &Case, state: &MatchState) {
        let by_id: BTreeMap<RecordId, &Score> = case.scores.iter().map(|s| (s.id, s)).collect();
        // How many scores of the same game replace `s`.
        let replacers = |s: &Score| {
            by_id
                .values()
                .filter(|r| r.slot == s.slot && r.replaces.contains(&s.id))
                .count()
        };
        // The longest chain of same-game replacements ending at `s`.
        fn depth(s: &Score, by_id: &BTreeMap<RecordId, &Score>) -> u32 {
            1 + s
                .replaces
                .iter()
                .filter_map(|id| by_id.get(id))
                .filter(|r| r.slot == s.slot)
                .map(|r| depth(r, by_id))
                .max()
                .unwrap_or(0)
        }
        let last = last_game(case.terms);
        let m = case.match_.match_id(&CRYPTO).unwrap();
        let any = |f: &dyn Fn(&Score) -> bool| u32::from(case.scores.iter().any(f));
        self.chain_of_3 += any(&|s| s.slot >= 1 && depth(s, &by_id) >= 3);
        self.branch += any(&|s| s.slot >= 1 && replacers(s) >= 2);
        self.several_current += u32::from(state.current.iter().any(|ids| ids.len() >= 2));
        self.slot_0_replacing +=
            any(&|s| s.slot == 0 && s.replaces.iter().any(|id| by_id.contains_key(id)));
        self.past_the_last_game += any(&|s| s.slot > last);
        self.past_255 += any(&|s| s.slot > 255);
        self.no_terms += u32::from(case.terms.is_none());
        self.two_trailing_empty += u32::from(state.current.len() >= state.games.len() + 2);
        self.other_match_replacing += u32::from(case.others.iter().any(|r| {
            r.scored_match().is_some_and(|o| o != m)
                && r.replaces().is_some_and(|ids| !ids.is_empty())
        }));
        self.doubles += u32::from(case.sides[0].len() == 2);
        // The set's highest-id record is signed by a key other than the
        // creator.
        let highest = case
            .others
            .iter()
            .chain([&case.match_])
            .max_by_key(|r| r.id(&CRYPTO))
            .unwrap();
        self.creator_not_highest_id += u32::from(highest.signer() != case.creator);
    }

    /// Counted per order, since the copies signed again are made per order.
    /// `set[0]` is the match record.
    fn note_order(&mut self, set: &[Record], order: &[Record]) {
        let re_signed = |r: &Record| !set.contains(r);
        let match_id = set[0].id(&CRYPTO);
        self.re_signed_match += u32::from(
            order
                .iter()
                .any(|r| re_signed(r) && r.id(&CRYPTO) == match_id),
        );
        self.re_signed_score += u32::from(
            order
                .iter()
                .any(|r| re_signed(r) && r.scored_match().is_some()),
        );
    }

    fn assert_all(&self) {
        let counts = [
            self.chain_of_3,
            self.branch,
            self.several_current,
            self.slot_0_replacing,
            self.past_the_last_game,
            self.past_255,
            self.no_terms,
            self.two_trailing_empty,
            self.other_match_replacing,
            self.doubles,
            self.creator_not_highest_id,
            self.re_signed_match,
            self.re_signed_score,
        ];
        assert!(
            counts.iter().all(|&n| n >= 20),
            "a shape was too rarely reached: {self:?}"
        );
    }
}
