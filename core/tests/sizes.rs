//! Measured sizes against the estimates in design section 6. Run with
//! `./bin/mise run core:test -- --test sizes -- --nocapture` to see the table.
//!
//! What a record weighs depends on the opaque terms and result content, whose
//! layouts are product schemas not designed yet. The fixtures assume 4 bytes
//! of terms and 10 bytes of content (a layout version, how the match ended,
//! the winner, four game scores); the variants below show how much that
//! matters.

mod common;

use common::{CONTENT, CRYPTO, ENV, TERMS, TestKey, keys};
use fortymm_core::{ClockReading, Draft, Parcel, Record, Subject};

struct Case {
    name: String,
    match_record: Record,
    first: Record,
    second: Record,
}

fn case(
    name: &str,
    match_signer: &TestKey,
    doubles: bool,
    terms: &[u8],
    content: &[u8],
    clock: bool,
    seen: usize,
) -> Case {
    let [alice, bob, carol, server] = keys();
    let _ = server;
    let clock = clock.then(|| ClockReading::from_unix_millis(1_794_355_200_000));
    let sides = if doubles {
        [
            vec![alice.own_player(), carol.own_player()],
            vec![bob.own_player(), match_signer.own_player()],
        ]
    } else {
        [vec![alice.own_player()], vec![bob.own_player()]]
    };
    let match_record = match_signer.commit(
        &Draft::match_(sides, terms.to_vec()).unwrap(),
        [1; 8],
        clock,
    );
    let subject = Subject {
        match_id: match_record.match_id(&CRYPTO).unwrap(),
        seen: (0..seen)
            .map(|i| fortymm_core::Tag::from_bytes([i as u8; 8]))
            .collect(),
        content: content.to_vec(),
    };
    let first = alice.commit(
        &Draft::result(subject.clone(), alice.own_player(), vec![]),
        [2; 8],
        clock,
    );
    let second = bob.commit(
        &Draft::result(subject, bob.own_player(), vec![]),
        [3; 8],
        clock,
    );
    Case {
        name: name.to_string(),
        match_record,
        first,
        second,
    }
}

#[test]
fn measured_sizes() {
    let [alice, _, _, server] = keys();
    let cases = vec![
        case(
            "singles, match by a player (fixture sizes)",
            &alice,
            false,
            &TERMS,
            &CONTENT,
            false,
            0,
        ),
        case(
            "singles, match by the server",
            &server,
            false,
            &TERMS,
            &CONTENT,
            false,
            0,
        ),
        case(
            "singles, with clock readings",
            &alice,
            false,
            &TERMS,
            &CONTENT,
            true,
            0,
        ),
        case(
            "singles, 16 B terms, 24 B content",
            &alice,
            false,
            &[0; 16],
            &[0; 24],
            false,
            0,
        ),
        case(
            "correction (seen list of 1)",
            &alice,
            false,
            &TERMS,
            &CONTENT,
            false,
            1,
        ),
        case("doubles", &alice, true, &TERMS, &CONTENT, false, 0),
        case(
            "doubles, clock, 16 B terms, 24 B content",
            &alice,
            true,
            &[0; 16],
            &[0; 24],
            true,
            0,
        ),
    ];
    println!();
    println!(
        "{:<44} {:>6} {:>6} | {:>6} {:>6} | {:>6} {:>6}",
        "case", "match", "result", "1 sig", "chars", "2 sigs", "chars"
    );
    println!(
        "{:<44} {:>6} {:>6} | {:>6} {:>6} | {:>6} {:>6}",
        "design estimate", "~200", "~200", "~370", "~610", "~505", "~830"
    );
    for c in &cases {
        let one = Parcel::new(ENV, vec![c.match_record.clone(), c.first.clone()]).unwrap();
        let two = Parcel::new(
            ENV,
            vec![c.match_record.clone(), c.first.clone(), c.second.clone()],
        )
        .unwrap();
        println!(
            "{:<44} {:>6} {:>6} | {:>6} {:>6} | {:>6} {:>6}",
            c.name,
            c.match_record.to_bytes().len(),
            c.first.to_bytes().len(),
            one.to_binary().len(),
            one.text().len(),
            two.to_binary().len(),
            two.text().len(),
        );
        assert!(two.text().len() < 1_200);
    }
    let link_overhead = "HTTPS://".len() + "/P/".len();
    println!("A link adds {link_overhead} characters plus the host name.");
    println!(
        "Record sizes are the standalone form: body + 64-byte signature + 4 bytes of framing."
    );
}
