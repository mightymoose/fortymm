//! A match's state, derived from its records (FORMAT.md section 16).
//!
//! The device's views of a match are computed from the records it holds and
//! can be thrown away and rebuilt (design section 5, "Everything else on the
//! device ... is a view computed from the journal by the shared core"; D16).
//! [`match_state`] is that computation for one match: its sides and terms
//! from the `match` record, and its scoreboard from the `score` records
//! (design section 7, "Scoreboard").
//!
//! It is a function of the set of records alone (L4): any order, any
//! repeats, the same state. It reads nothing but the records: no clock, no
//! random value. It does not judge a score (whether a game can end so, or the
//! match is decided); that is the app's rule.

use std::collections::{BTreeMap, BTreeSet};

use crate::crypto::Crypto;
use crate::ids::{MatchId, PlayerId, PublicKey, RecordId};
use crate::layout::match_state::MAX_GAME;
use crate::product::{ScoreValue, Terms};
use crate::record::{Content, Record};

/// What a match's records say, as a device shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchState {
    /// The match: the record id of its `match` record.
    pub match_id: MatchId,
    /// The key that signed the `match` record.
    pub creator: PublicKey,
    /// The two sides, as the `match` record names them.
    pub sides: [Vec<PlayerId>; 2],
    /// The terms, or None for terms this build does not read (another layout
    /// version, or damaged).
    pub terms: Option<Terms>,
    /// Each game's final score, first side's points first: `games[0]` is
    /// game 1. None for a game with no score: none entered, cleared, or a
    /// value this build does not read. Never ends with a None.
    pub games: Vec<Option<[u32; 2]>>,
    /// For each game, `current[0]` for game 1, the ids of its `score` records
    /// that no `score` record of that game replaces, lowest id first. It runs
    /// to the last game that has any, so it can be longer than `games`: a
    /// game cleared at the end has no score but still has its current entry,
    /// which the next score for that game names as replaced.
    pub current: Vec<Vec<RecordId>>,
}

/// The state of the match the records are about, or None when the set holds
/// no `match` record, or holds `match` records of more than one match.
///
/// `records` is the set a device holds that concerns the match, in any order
/// and with repeats. `score` records of other matches, and records of other
/// kinds, may be mixed in; they are ignored. A `match` record of another
/// match is not ignored: with it there is no state, so pass only this
/// match's records. Signatures are not checked here: a held record was
/// verified when it was taken in (R1).
pub fn match_state(records: &[Record], crypto: &impl Crypto) -> Option<MatchState> {
    // The set: one entry per record id, in id order, so nothing below
    // depends on the order or the repeats of the input.
    let set: BTreeMap<RecordId, &Record> = records
        .iter()
        .map(|record| (record.id(crypto), record))
        .collect();

    let mut matches = set
        .iter()
        .filter_map(|(id, record)| match record.content() {
            Content::Match { sides, terms } => {
                Some((MatchId::from_bytes(*id.as_bytes()), *record, sides, terms))
            }
            _ => None,
        });
    let (match_id, match_record, sides, terms) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }

    // The match's scoreboard: every `score` record that names this match.
    let scores: Vec<(RecordId, &Record)> = set
        .iter()
        .filter(|(_, record)| record.scored_match() == Some(match_id))
        .map(|(id, record)| (*id, *record))
        .collect();
    // An entry for game n is current if no score record of this match for
    // game n names it as replaced: a score replaces only earlier scores of
    // its own game. A score of another match replaces nothing here.
    let replaced: BTreeSet<(u64, RecordId)> = scores
        .iter()
        .flat_map(|(_, record)| {
            let slot = record.slot().unwrap_or_default();
            let replaces = record.replaces().unwrap_or_default();
            replaces.iter().map(move |id| (slot, *id))
        })
        .collect();
    // The last game there can be: the terms' best of, or with no terms it
    // reads, MAX_GAME, which also caps a best of above it.
    let last_game =
        Terms::read(terms).map_or(MAX_GAME, |terms| u64::from(terms.best_of()).min(MAX_GAME));
    // Current entries by game. Slot 0 is accepted in a record but has no value
    // layout and is no game, so it is ignored, as is a game past the last.
    let mut by_game: BTreeMap<u64, Vec<(RecordId, &Record)>> = BTreeMap::new();
    for (id, record) in &scores {
        let slot = record.slot().unwrap_or_default();
        if (1..=last_game).contains(&slot) && !replaced.contains(&(slot, *id)) {
            by_game.entry(slot).or_default().push((*id, *record));
        }
    }

    let last = by_game.keys().next_back().copied().unwrap_or(0);
    let mut games = Vec::new();
    let mut current = Vec::new();
    for slot in 1..=last {
        let entries = by_game.get(&slot).map(Vec::as_slice).unwrap_or_default();
        current.push(entries.iter().map(|(id, _)| *id).collect());
        // PLACEHOLDER (FORMAT.md section 16): of several current entries for
        // one game, the one with the highest record id is shown (`entries`
        // is in id order). The design leaves this choice to a policy function
        // of the set (sections 7, 12 and 16), not decided yet. This stand-in
        // is deterministic and plainly arbitrary, has no golden vector, and
        // is replaced before sync is built.
        games.push(entries.last().and_then(|(_, record)| shown(record)));
    }
    while games.last() == Some(&None) {
        games.pop();
    }

    Some(MatchState {
        match_id,
        creator: match_record.signer(),
        sides: sides.clone(),
        terms: Terms::read(terms),
        games,
        current,
    })
}

/// The score a game shows from the entry chosen for it. A value this build
/// does not read gives no score, as a cleared one does.
fn shown(entry: &Record) -> Option<[u32; 2]> {
    match ScoreValue::read(entry.value()?)? {
        ScoreValue::Points(points) => Some(points),
        ScoreValue::Cleared => None,
    }
}
