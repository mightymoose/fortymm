//! Golden vectors (design section 4.5): record values, their exact bytes and
//! ids; parcels and their text; signature conversions; checksums.
//!
//! The file is `vectors/vectors.json`. This test rebuilds every vector from
//! the fixtures and fails if the file differs. Before the first public
//! release the format may change (design section 18): regenerate with
//! `./bin/mise run core:test -- --test vectors -- --ignored regenerate`.
//! Once released, vectors are never edited, only added.
//!
//! The WebAssembly and Python builds check the same file (bindings/).

mod common;

use common::{CRYPTO, ENV, TERMS, TestKey, fixtures, hex, high_s, random, raw_body};
use fortymm_core::cbor::Value;
use fortymm_core::ids::label;
use fortymm_core::layout::username::MAX_SUFFIX_LENGTH;
use fortymm_core::parcel::checksum;
use fortymm_core::{
    ClockReading, Content, Draft, Environment, Kind, MatchId, Parcel, PlayerId, PublicKey, Record,
    RecordId, Signature,
};
use fortymm_core::{ScoreValue, Terms};
use serde_json::{Value as Json, json};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/vectors.json");
const HOST: &str = "fortymm.example";

fn record_json(name: &str, record: &Record) -> Json {
    let mut entry = json!({
        "name": name,
        "kind": record.header().kind,
        "kind_name": record.kind().map(Kind::name),
        "interpreted": !matches!(record.content(), Content::Other(_)),
        "format_version": record.header().format_version,
        "environment": record.header().environment.0,
        "signer": hex(record.header().signer.as_bytes()),
        "random": hex(&record.header().random),
        "body": hex(record.body()),
        "signature": hex(record.signature().as_bytes()),
        "record": hex(&record.to_bytes()),
        "id": hex(record.id(&CRYPTO).as_bytes()),
        "signer_account_id": hex(record.signer_account_id(&CRYPTO).as_bytes()),
        "signer_own_player_id": hex(record.signer_own_player_id(&CRYPTO).as_bytes()),
    });
    let object = entry.as_object_mut().unwrap();
    if let Some(id) = record.match_id(&CRYPTO) {
        object.insert("match_id".into(), json!(hex(id.as_bytes())));
    }
    if let Some(id) = record.extra_player_id(&CRYPTO) {
        object.insert("extra_player_id".into(), json!(hex(id.as_bytes())));
    }
    // The getters. A key is present exactly when the getter gives a value.
    if let Some(sides) = record.sides() {
        let sides: Vec<Vec<String>> = sides
            .iter()
            .map(|side| side.iter().map(|p| hex(p.as_bytes())).collect())
            .collect();
        object.insert("sides".into(), json!(sides));
    }
    if let Some(terms) = record.terms() {
        object.insert("terms".into(), json!(hex(terms)));
    }
    if let Some(repeats) = record.repeats_player() {
        object.insert("repeats_player".into(), json!(repeats));
    }
    if let Some(key) = record.creator() {
        object.insert("creator".into(), json!(hex(key.as_bytes())));
    }
    if let Some(key) = record.introduced_key() {
        object.insert("introduced_key".into(), json!(hex(key.as_bytes())));
    }
    if let Some(subject) = record.subject() {
        let outcome = subject.outcome_id(&CRYPTO);
        object.insert("subject".into(), json!(hex(&subject.to_bytes())));
        object.insert("outcome_id".into(), json!(hex(outcome.as_bytes())));
        object.insert("tag".into(), json!(hex(outcome.tag().as_bytes())));
    }
    // A score's getters, present together and only for a `score`.
    if let Some(id) = record.scored_match() {
        object.insert("scored_match".into(), json!(hex(id.as_bytes())));
    }
    if let Some(slot) = record.slot() {
        object.insert("slot".into(), json!(slot));
    }
    if let Some(value) = record.value() {
        object.insert("value".into(), json!(hex(value)));
    }
    if let Some(replaces) = record.replaces() {
        let replaces: Vec<String> = replaces.iter().map(|id| hex(id.as_bytes())).collect();
        object.insert("replaces".into(), json!(replaces));
    }
    entry
}

fn invalid_records() -> Vec<(&'static str, Vec<u8>)> {
    let fixtures = fixtures();
    let alice = &fixtures.keys[0];
    let hello = fixtures.get("hello");
    let standalone = |body: &[u8], signature: &[u8]| {
        fortymm_core::cbor::encode(&Value::Array(vec![
            Value::Bytes(body.to_vec()),
            Value::Bytes(signature.to_vec()),
        ]))
    };
    let signed = |body: Vec<u8>| {
        let signature = alice.sign_body(&body);
        standalone(&body, signature.as_bytes())
    };
    let r = random(1);
    let mut long_version = hello.body().to_vec();
    long_version.splice(2..3, [0x18, 0x01]);
    let mut trailing = hello.body().to_vec();
    trailing.push(0);
    let mut uncompressed = hello.body().to_vec();
    let at = uncompressed
        .windows(2)
        .position(|w| w == [0x58, 33])
        .unwrap()
        + 2;
    uncompressed[at] = 0x04;
    vec![
        ("integer-not-shortest", signed(long_version)),
        ("trailing-byte-in-body", signed(trailing)),
        ("signer-not-compressed", signed(uncompressed)),
        (
            "random-value-missing",
            signed(fortymm_core::cbor::encode(&Value::Map(vec![
                (0, Value::Uint(1)),
                (1, Value::Uint(Kind::Hello.number())),
                (2, Value::Uint(ENV.0)),
                (3, Value::Bytes(alice.public().as_bytes().to_vec())),
            ]))),
        ),
        (
            "random-value-wrong-length",
            signed(fortymm_core::cbor::encode(&Value::Map(vec![
                (0, Value::Uint(1)),
                (1, Value::Uint(Kind::Hello.number())),
                (2, Value::Uint(ENV.0)),
                (3, Value::Bytes(alice.public().as_bytes().to_vec())),
                (4, Value::Bytes(vec![0; 7])),
            ]))),
        ),
        (
            "unexpected-field-in-known-kind",
            signed(raw_body(
                alice,
                1,
                Kind::Hello.number(),
                ENV.0,
                r,
                vec![(8, Value::Uint(0))],
            )),
        ),
        (
            "stamp-missing-on-request",
            signed(raw_body(
                alice,
                1,
                Kind::Release.number(),
                ENV.0,
                r,
                vec![(8, Value::Bytes(vec![0; 32]))],
            )),
        ),
        (
            "stamp-on-kind-without-one",
            signed(raw_body(
                alice,
                1,
                Kind::Player.number(),
                ENV.0,
                r,
                vec![(6, Value::Bytes(vec![0; 8]))],
            )),
        ),
        ("text-string-in-body", {
            let mut body = raw_body(alice, 1, 999, ENV.0, r, vec![(8, Value::Uint(0))]);
            let last = body.len() - 1;
            body[last] = 0x60;
            signed(body)
        }),
        ("float-in-body", {
            let mut body = raw_body(alice, 1, 999, ENV.0, r, vec![(8, Value::Uint(0))]);
            body.pop();
            body.extend([0xf9, 0x3c, 0x00]);
            signed(body)
        }),
        ("keys-out-of-order", {
            let body = hello.body();
            // Map head, then entries 0,1,2 as single bytes pairs.
            let mut swapped = body.to_vec();
            swapped[3..5].copy_from_slice(&body[5..7]);
            swapped[5..7].copy_from_slice(&body[3..5]);
            signed(swapped)
        }),
        (
            "signature-high-s",
            standalone(hello.body(), &high_s(hello.signature())),
        ),
        (
            "signature-63-bytes",
            standalone(hello.body(), &hello.signature().as_bytes()[..63]),
        ),
        ("signature-r-zero", {
            let mut signature = *hello.signature().as_bytes();
            signature[..32].fill(0);
            standalone(hello.body(), &signature)
        }),
        (
            "record-not-a-pair",
            fortymm_core::cbor::encode(&Value::Array(vec![Value::Bytes(hello.body().to_vec())])),
        ),
    ]
}

fn unverifiable_records() -> Vec<(&'static str, Vec<u8>)> {
    let fixtures = fixtures();
    let [alice, bob, ..] = &fixtures.keys;
    let hello = fixtures.get("hello");
    let mut changed_env = hello.body().to_vec();
    assert_eq!(&changed_env[5..7], &[0x02, ENV.0 as u8]);
    changed_env[6] = 1;
    let wrong_key = {
        let body = Draft::hello()
            .body(ENV, alice.public(), random(30), None)
            .unwrap();
        let signature = Signature::from_der(&bob.sign_der(&body)).unwrap();
        Record::assemble(body, signature).unwrap()
    };
    vec![
        (
            "environment-changed-after-signing",
            Record::assemble(changed_env, *hello.signature())
                .unwrap()
                .to_bytes(),
        ),
        ("signed-by-another-key", wrong_key.to_bytes()),
    ]
}

/// Hellos made the way a platform makes one (design section 4.4): the core
/// builds the body from the key, the environment, the random value and the
/// clock reading; the platform signs it (here as WebCrypto does, raw r||s);
/// the core converts the signature, assembles the record and verifies it.
/// Each build makes the body and the record from these inputs and must get
/// exactly these bytes.
fn made_hellos() -> Vec<Json> {
    let fixtures = fixtures();
    let [alice, bob, carol, _] = &fixtures.keys;
    let cases = [
        ("hello", alice, ENV, random(1), None),
        (
            "hello-with-clock",
            bob,
            ENV,
            random(40),
            Some(1_794_355_200_000u64),
        ),
        (
            "hello-production",
            carol,
            Environment::PRODUCTION,
            random(41),
            None,
        ),
    ];
    cases
        .into_iter()
        .map(|(name, key, environment, random, clock)| {
            let body = Draft::hello()
                .body(
                    environment,
                    key.public(),
                    random,
                    clock.map(ClockReading::from_unix_millis),
                )
                .unwrap();
            let raw = key.sign_raw(&body);
            let signature = Signature::from_raw(&raw).unwrap();
            let record = Record::assemble_verified(body.clone(), signature, &CRYPTO).unwrap();
            if name == "hello" {
                // The same inputs as the fixture, so the same record.
                assert_eq!(&record, fixtures.get("hello"));
            }
            json!({
                "name": name,
                "environment": environment.0,
                "signer": hex(key.public().as_bytes()),
                "random": hex(&random),
                "clock": clock,
                "body": hex(&body),
                "raw_signature": hex(&raw),
                "record": hex(&record.to_bytes()),
            })
        })
        .collect()
}

/// Inputs a hello cannot be made from: a key that is not in the stored form
/// (33 bytes, starting 02 or 03), or a random value that is not 8 bytes.
fn invalid_hello_inputs() -> Vec<Json> {
    let fixtures = fixtures();
    let key = fixtures.keys[0].public();
    let key = key.as_bytes();
    let mut uncompressed_prefix = key.to_vec();
    uncompressed_prefix[0] = 0x04;
    let good_random = hex(&random(1));
    let cases = [
        ("signer-32-bytes", hex(&key[..32]), good_random.clone()),
        (
            "signer-34-bytes",
            hex(&[key.as_slice(), &[0]].concat()),
            good_random.clone(),
        ),
        (
            "signer-uncompressed-prefix",
            hex(&uncompressed_prefix),
            good_random.clone(),
        ),
        ("signer-empty", String::new(), good_random),
        ("random-7-bytes", hex(key), hex(&random(1)[..7])),
        (
            "random-9-bytes",
            hex(key),
            hex(&[random(1).as_slice(), &[0]].concat()),
        ),
        ("random-empty", hex(key), String::new()),
    ];
    cases
        .into_iter()
        .map(|(name, signer, random)| {
            json!({"name": name, "environment": ENV.0, "signer": signer, "random": random})
        })
        .collect()
}

// ---- The product layouts (FORMAT.md section 15) ----------------------------

/// The profile's bytes of a map.
fn map_bytes(entries: Vec<(u64, Value)>) -> Vec<u8> {
    fortymm_core::cbor::encode(&Value::Map(entries))
}

/// Terms and their exact bytes: each best of the app offers, rated and not,
/// and the largest best of.
fn terms_vectors() -> Vec<Json> {
    [1, 3, 5, 7, u32::MAX]
        .into_iter()
        .flat_map(|best_of| [false, true].map(|rated| Terms::new(best_of, rated).unwrap()))
        .map(|terms| {
            json!({
                "best_of": terms.best_of(),
                "rated": terms.rated(),
                "bytes": hex(&terms.to_bytes()),
            })
        })
        .collect()
}

/// Score values and their exact bytes. A cleared one has `score` null.
fn score_value_vectors() -> Vec<Json> {
    [
        ScoreValue::Cleared,
        ScoreValue::Points([11, 9]),
        ScoreValue::Points([9, 11]),
        ScoreValue::Points([0, 11]),
        ScoreValue::Points([24, 26]),
        ScoreValue::Points([u32::MAX, 0]),
    ]
    .into_iter()
    .map(|value| {
        let score = match value {
            ScoreValue::Points(points) => json!(points),
            ScoreValue::Cleared => Json::Null,
        };
        json!({"score": score, "bytes": hex(&value.to_bytes())})
    })
    .collect()
}

/// Bytes that are not terms: another layout version, and damage.
fn unreadable_terms() -> Vec<(&'static str, Vec<u8>)> {
    let terms = |version: u64, best_of: Value, rated: Value| {
        map_bytes(vec![(0, Value::Uint(version)), (1, best_of), (2, rated)])
    };
    let good = Terms::new(5, true).unwrap().to_bytes();
    vec![
        ("version-2", terms(2, Value::Uint(5), Value::Uint(1))),
        ("version-0", terms(0, Value::Uint(5), Value::Uint(1))),
        ("empty", vec![]),
        ("truncated", good[..good.len() - 1].to_vec()),
        ("trailing-byte", [good.as_slice(), &[0]].concat()),
        ("best-of-zero", terms(1, Value::Uint(0), Value::Uint(1))),
        ("best-of-even", terms(1, Value::Uint(4), Value::Uint(1))),
        (
            "best-of-too-large",
            terms(1, Value::Uint(u64::from(u32::MAX) + 2), Value::Uint(1)),
        ),
        (
            "best-of-not-a-number",
            terms(1, Value::Bytes(vec![5]), Value::Uint(1)),
        ),
        ("rated-2", terms(1, Value::Uint(5), Value::Uint(2))),
        (
            "rated-missing",
            map_bytes(vec![(0, Value::Uint(1)), (1, Value::Uint(5))]),
        ),
        (
            "extra-entry",
            map_bytes(vec![
                (0, Value::Uint(1)),
                (1, Value::Uint(5)),
                (2, Value::Uint(1)),
                (3, Value::Uint(11)),
            ]),
        ),
        (
            "version-missing",
            map_bytes(vec![(1, Value::Uint(5)), (2, Value::Uint(1))]),
        ),
        (
            "an-array",
            fortymm_core::cbor::encode(&Value::Array(vec![
                Value::Uint(1),
                Value::Uint(5),
                Value::Uint(1),
            ])),
        ),
        (
            "integer-not-shortest",
            vec![0xa3, 0x00, 0x01, 0x01, 0x18, 0x05, 0x02, 0x01],
        ),
        (
            "rated-as-cbor-true",
            vec![0xa3, 0x00, 0x01, 0x01, 0x05, 0x02, 0xf5],
        ),
        ("a-score-value", ScoreValue::Points([11, 9]).to_bytes()),
        ("the-fixtures-stand-in", common::TERMS.to_vec()),
    ]
}

/// Bytes that are not a score value: another layout version, and damage.
fn unreadable_score_values() -> Vec<(&'static str, Vec<u8>)> {
    let points = |items: Vec<u64>| Value::Array(items.into_iter().map(Value::Uint).collect());
    let value =
        |version: u64, points: Value| map_bytes(vec![(0, Value::Uint(version)), (1, points)]);
    let good = ScoreValue::Points([11, 9]).to_bytes();
    vec![
        ("version-2", value(2, points(vec![11, 9]))),
        ("version-2-cleared", map_bytes(vec![(0, Value::Uint(2))])),
        ("version-0", value(0, points(vec![11, 9]))),
        ("empty", vec![]),
        ("empty-map", map_bytes(vec![])),
        ("truncated", good[..good.len() - 1].to_vec()),
        ("trailing-byte", [good.as_slice(), &[0]].concat()),
        ("one-side", value(1, points(vec![11]))),
        ("three-sides", value(1, points(vec![11, 9, 7]))),
        ("no-sides", value(1, points(vec![]))),
        (
            "points-too-large",
            value(1, points(vec![u64::from(u32::MAX) + 1, 0])),
        ),
        ("points-not-an-array", value(1, Value::Uint(11))),
        (
            "points-as-bytes",
            value(
                1,
                Value::Array(vec![Value::Bytes(vec![11]), Value::Bytes(vec![9])]),
            ),
        ),
        (
            "extra-entry",
            map_bytes(vec![
                (0, Value::Uint(1)),
                (1, points(vec![11, 9])),
                (2, Value::Uint(0)),
            ]),
        ),
        ("version-missing", map_bytes(vec![(1, points(vec![11, 9]))])),
        (
            "integer-not-shortest",
            vec![0xa2, 0x00, 0x01, 0x01, 0x82, 0x18, 0x0b, 0x09],
        ),
        ("cleared-as-cbor-null", vec![0xa2, 0x00, 0x01, 0x01, 0xf6]),
        ("terms", Terms::new(5, true).unwrap().to_bytes()),
    ]
}

/// Add the product layouts' vectors to the file.
fn add_layout_vectors(file: &mut Json) {
    let named = |cases: Vec<(&'static str, Vec<u8>)>| -> Json {
        cases
            .into_iter()
            .map(|(name, bytes)| json!({"name": name, "bytes": hex(&bytes)}))
            .collect()
    };
    let object = file.as_object_mut().unwrap();
    object.insert("terms".into(), json!(terms_vectors()));
    object.insert("unreadable_terms".into(), named(unreadable_terms()));
    object.insert("invalid_best_ofs".into(), json!([0, 2, 4, 6, u32::MAX - 1]));
    object.insert("score_values".into(), json!(score_value_vectors()));
    object.insert(
        "unreadable_score_values".into(),
        named(unreadable_score_values()),
    );
}

/// One made record: its inputs, the body, the platform's raw signature, the
/// record and its id. The inputs after the header are under the getters'
/// names: `sides` and `terms` for a `match`; `scored_match`, `slot`, `value`
/// and `replaces` for a `score`.
fn made_record(
    name: &str,
    key: &TestKey,
    environment: Environment,
    draft: &Draft,
    random: [u8; 8],
    clock: Option<u64>,
) -> (Json, Record) {
    let body = draft
        .body(
            environment,
            key.public(),
            random,
            clock.map(ClockReading::from_unix_millis),
        )
        .unwrap();
    let raw = key.sign_raw(&body);
    let signature = Signature::from_raw(&raw).unwrap();
    let record = Record::assemble_verified(body.clone(), signature, &CRYPTO).unwrap();
    let mut entry = json!({
        "name": name,
        "kind_name": draft.kind().name(),
        "environment": environment.0,
        "signer": hex(key.public().as_bytes()),
        "random": hex(&random),
        "clock": clock,
        "body": hex(&body),
        "raw_signature": hex(&raw),
        "record": hex(&record.to_bytes()),
        "id": hex(record.id(&CRYPTO).as_bytes()),
    });
    let object = entry.as_object_mut().unwrap();
    let ids = |ids: &[&[u8; 32]]| ids.iter().map(|id| hex(*id)).collect::<Vec<_>>();
    match record.content() {
        Content::Match { sides, terms } => {
            let sides: Vec<Vec<String>> = sides
                .iter()
                .map(|side| ids(&side.iter().map(PlayerId::as_bytes).collect::<Vec<_>>()))
                .collect();
            object.insert("sides".into(), json!(sides));
            object.insert("terms".into(), json!(hex(terms)));
        }
        Content::Score {
            match_id,
            slot,
            value,
            replaces,
        } => {
            object.insert("scored_match".into(), json!(hex(match_id.as_bytes())));
            object.insert("slot".into(), json!(slot));
            object.insert("value".into(), json!(hex(value)));
            let replaces = ids(&replaces.iter().map(RecordId::as_bytes).collect::<Vec<_>>());
            object.insert("replaces".into(), json!(replaces));
        }
        _ => {}
    }
    (entry, record)
}

/// A `player`, a `match` and a `score` made the way a platform makes them
/// (see `made_hellos`): body from the inputs, raw signature converted, record
/// assembled and verified. Each build makes the same bytes from these inputs.
/// The match names both made players as sides, and the scores are about the
/// made match.
fn made_records() -> Vec<Json> {
    let fixtures = fixtures();
    let [alice, bob, ..] = &fixtures.keys;
    let clock = Some(1_794_355_200_000u64);
    let mut made = Vec::new();
    let mut make = |name, key, environment, draft: Draft, random, clock| {
        let (entry, record) = made_record(name, key, environment, &draft, random, clock);
        made.push(entry);
        record
    };

    // Two players from one key: only the random value tells them apart.
    let first = make("player", alice, ENV, Draft::player(), random(50), None);
    let second = make(
        "player-with-clock",
        alice,
        ENV,
        Draft::player(),
        random(51),
        clock,
    );
    let extra = |record: &Record| record.extra_player_id(&CRYPTO).unwrap();
    make(
        "player-production",
        bob,
        Environment::PRODUCTION,
        Draft::player(),
        random(50),
        None,
    );

    let sides = [
        vec![alice.own_player(), extra(&first)],
        vec![bob.own_player(), extra(&second)],
    ];
    let match_ = make(
        "match",
        alice,
        ENV,
        Draft::match_(sides, TERMS.to_vec()).unwrap(),
        random(52),
        clock,
    );
    let match_id = match_.match_id(&CRYPTO).unwrap();

    let score = make(
        "score",
        bob,
        ENV,
        Draft::score(match_id, 1, vec![11, 9], vec![]),
        random(53),
        None,
    );
    let corrected = make(
        "score-replacing",
        alice,
        ENV,
        Draft::score(match_id, 1, vec![11, 7], vec![score.id(&CRYPTO)]),
        random(54),
        clock,
    );
    // The whole match's slot, an empty value, and two replaced ids.
    make(
        "score-empty-value-replacing-two",
        alice,
        ENV,
        Draft::score(
            match_id,
            0,
            vec![],
            vec![score.id(&CRYPTO), corrected.id(&CRYPTO)],
        ),
        random(55),
        None,
    );
    made
}

/// The draft a made record's entry describes, read from the file alone.
fn draft_of(entry: &Json) -> Draft {
    let id =
        |value: &Json| -> [u8; 32] { common::unhex(value.as_str().unwrap()).try_into().unwrap() };
    let bytes = |key: &str| common::unhex(entry[key].as_str().unwrap());
    match entry["kind_name"].as_str().unwrap() {
        "player" => Draft::player(),
        "match" => {
            let sides: Vec<Vec<PlayerId>> = entry["sides"]
                .as_array()
                .unwrap()
                .iter()
                .map(|side| {
                    let side = side.as_array().unwrap();
                    side.iter().map(|p| PlayerId::from_bytes(id(p))).collect()
                })
                .collect();
            Draft::match_(sides.try_into().unwrap(), bytes("terms")).unwrap()
        }
        "score" => Draft::score(
            MatchId::from_bytes(id(&entry["scored_match"])),
            entry["slot"].as_u64().unwrap(),
            bytes("value"),
            entry["replaces"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| RecordId::from_bytes(id(r)))
                .collect(),
        ),
        other => panic!("no made record of kind {other}"),
    }
}

fn parcel_json(name: &str, parcel: &Parcel) -> Json {
    json!({
        "name": name,
        "environment": parcel.environment().0,
        "records": parcel.records().iter().map(|r| hex(&r.to_bytes())).collect::<Vec<_>>(),
        "binary": hex(&parcel.to_binary()),
        "text": parcel.text(),
        "link": parcel.link(HOST),
    })
}

fn build() -> Json {
    let fixtures = fixtures();
    let records: Vec<Json> = fixtures
        .records
        .iter()
        .map(|(name, record)| record_json(name, record))
        .collect();

    let get = |name: &str| fixtures.get(name).clone();
    let agreed = Parcel::new(
        ENV,
        vec![
            get("match"),
            get("result-first-side"),
            get("result-second-side"),
        ],
    )
    .unwrap();
    let one = Parcel::new(ENV, vec![get("match"), get("result-first-side")]).unwrap();
    let grant = Parcel::new(
        ENV,
        vec![get("player"), get("grant-giving"), get("grant-receiving")],
    )
    .unwrap();
    let carried = Parcel::new(
        ENV,
        vec![
            get("unknown-kind"),
            get("name-not-interpreted"),
            get("future-format-version"),
        ],
    )
    .unwrap();
    let all = Parcel::new(
        ENV,
        fixtures.records.iter().map(|(_, r)| r.clone()).collect(),
    )
    .unwrap();
    let parcels = vec![
        parcel_json("match-and-one-result", &one),
        parcel_json("match-and-agreed-result", &agreed),
        parcel_json("grant-both-sides", &grant),
        parcel_json("kinds-carried-without-interpreting", &carried),
        parcel_json("every-fixture", &all),
    ];

    let text = agreed.text();
    let mut damaged = vec![];
    let mut substituted = text.clone().into_bytes();
    substituted[100] = if substituted[100] == b'0' { b'1' } else { b'0' };
    damaged.push(json!({"name": "one-character-substituted", "text": String::from_utf8(substituted).unwrap()}));
    damaged.push(json!({"name": "one-character-deleted", "text": format!("{}{}", &text[..200], &text[201..])}));
    damaged.push(json!({"name": "one-character-inserted", "text": format!("{}7{}", &text[..300], &text[300..])}));
    damaged.push(json!({"name": "truncated", "text": &text[..text.len() - 8]}));
    damaged.push(json!({"name": "letter-outside-alphabet", "text": format!("{}U{}", &text[..10], &text[11..])}));
    damaged.push(json!({"name": "two-parcels-joined", "text": format!("{}{}", one.text(), text)}));
    damaged.push(json!({"name": "empty", "text": ""}));
    damaged.push(
        json!({"name": "link-with-wrong-path", "text": format!("HTTPS://{}/Q/{}", HOST, text)}),
    );

    let wrapped: Vec<&str> = text
        .as_bytes()
        .chunks(60)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect();
    let harmless = vec![
        json!({"name": "lower-case", "text": text.to_lowercase(), "parcel": "match-and-agreed-result"}),
        json!({"name": "line-breaks-and-spaces", "text": format!("  {}\n", wrapped.join("\r\n ")), "parcel": "match-and-agreed-result"}),
        json!({"name": "lower-case-link", "text": agreed.link(HOST).to_lowercase(), "parcel": "match-and-agreed-result"}),
    ];

    let keys = &fixtures.keys;
    let mut signatures = vec![];
    for (index, key) in keys.iter().enumerate() {
        for message in [b"".as_slice(), b"fortymm", fixtures.get("match").body()] {
            let platform = key.sign_platform(message);
            let stored = Signature::from_der(platform.to_der().as_bytes()).unwrap();
            signatures.push(json!({
                "key": key.name,
                "public_key": hex(key.public().as_bytes()),
                "message": hex(message),
                "der": hex(platform.to_der().as_bytes()),
                "raw": hex(&platform.to_bytes()),
                "stored": hex(stored.as_bytes()),
                "platform_was_high_s": platform.normalize_s().is_some(),
            }));
        }
        // A deliberately high-s raw signature: conversion must lower it.
        if index == 0 {
            let stored = Signature::from_der(&key.sign_der(b"high")).unwrap();
            signatures.push(json!({
                "key": key.name,
                "public_key": hex(key.public().as_bytes()),
                "message": hex(b"high"),
                "raw": hex(&high_s(&stored)),
                "stored": hex(stored.as_bytes()),
                "platform_was_high_s": true,
            }));
        }
    }
    let bad_der = vec![
        json!({"name": "trailing-byte", "der": "300602010102010200"}),
        json!({"name": "leading-zero", "der": "300702020001020102"}),
        json!({"name": "negative", "der": "3006020181020102"}),
        json!({"name": "long-form-length", "der": "308106020101020102"}),
        json!({"name": "r-zero", "der": "3006020100020101"}),
    ];

    // Generated usernames: every key's own player, the extra player, and the
    // two ends of the id range, at the shortest suffix, one more, and the
    // longest.
    let mut players: Vec<PlayerId> = keys.iter().map(|k| k.own_player()).collect();
    players.push(fixtures.get("player").extra_player_id(&CRYPTO).unwrap());
    players.push(PlayerId::from_bytes([0; 32]));
    players.push(PlayerId::from_bytes([0xff; 32]));
    let usernames: Vec<Json> = players
        .iter()
        .flat_map(|player| {
            [4, 5, MAX_SUFFIX_LENGTH].map(|length| {
                json!({
                    "player_id": hex(player.as_bytes()),
                    "suffix_length": length,
                    "username": player.username(length).unwrap(),
                })
            })
        })
        .collect();

    let checksums: Vec<Json> = [b"".as_slice(), b"123456789", b"\x00", b"\xff\xff\xff\xff"]
        .iter()
        .map(|input| json!({"input": hex(input), "checksum": format!("{:08x}", checksum(input))}))
        .collect();

    let mut file = json!({
        "about": "FortyMM core golden vectors. Format choices are in core/FORMAT.md. Hex is lower case. Every record here verifies unless listed under unverifiable_records.",
        "format_version": fortymm_core::layout::FORMAT_VERSION,
        "labels": {
            "account": hex(label::ACCOUNT),
            "own_player": hex(label::OWN_PLAYER),
            "outcome": hex(label::OUTCOME),
        },
        "keys": keys.iter().map(|k| json!({
            "name": k.name,
            "public_key": hex(k.public().as_bytes()),
            "account_id": hex(k.public().account_id(&CRYPTO).as_bytes()),
            "own_player_id": hex(k.own_player().as_bytes()),
        })).collect::<Vec<_>>(),
        "records": records,
        "invalid_records": invalid_records().into_iter().map(|(name, bytes)| json!({"name": name, "record": hex(&bytes)})).collect::<Vec<_>>(),
        "unverifiable_records": unverifiable_records().into_iter().map(|(name, bytes)| json!({"name": name, "record": hex(&bytes)})).collect::<Vec<_>>(),
        "made_hellos": made_hellos(),
        "invalid_hello_inputs": invalid_hello_inputs(),
        "made_records": made_records(),
        "parcels": parcels,
        "damaged_parcel_texts": damaged,
        "harmless_parcel_texts": harmless,
        "signatures": signatures,
        "invalid_der": bad_der,
        "checksums": checksums,
        "usernames": usernames,
        "invalid_username_suffix_lengths": [0, 1, 3, MAX_SUFFIX_LENGTH + 1],
    });
    add_layout_vectors(&mut file);
    file
}

fn rendered() -> String {
    let mut text = serde_json::to_string_pretty(&build()).unwrap();
    text.push('\n');
    text
}

#[test]
fn vectors_file_matches() {
    let expected = std::fs::read_to_string(PATH).expect("vectors/vectors.json exists");
    assert!(
        expected == rendered(),
        "vectors/vectors.json differs from what the code produces. Before the first release, \
         regenerate it: ./bin/mise run core:test -- --test vectors -- --ignored regenerate"
    );
}

#[test]
#[ignore = "writes vectors/vectors.json"]
fn regenerate() {
    std::fs::write(PATH, rendered()).unwrap();
}

/// The vectors are checked here the way another build checks them: from the
/// file alone, without the fixtures.
#[test]
fn vectors_check_from_the_file_alone() {
    let file: Json = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
    let unhex = common::unhex;
    for entry in file["records"].as_array().unwrap() {
        let record = Record::decode(&unhex(entry["record"].as_str().unwrap())).unwrap();
        assert_eq!(hex(record.body()), entry["body"]);
        assert_eq!(hex(&record.to_bytes()), entry["record"]);
        assert_eq!(hex(record.id(&CRYPTO).as_bytes()), entry["id"]);
        assert!(record.verify(&CRYPTO).is_ok());
        if let Some(outcome) = entry.get("outcome_id") {
            assert_eq!(
                &json!(hex(record.outcome_id(&CRYPTO).unwrap().as_bytes())),
                outcome
            );
        }
        // Each getter gives the entry's value, or nothing when it has none.
        let field = |key: &str| entry.get(key).cloned().unwrap_or(Json::Null);
        let key_hex = |key: Option<fortymm_core::PublicKey>| json!(key.map(|k| hex(k.as_bytes())));
        assert_eq!(json!(hex(record.signer().as_bytes())), entry["signer"]);
        assert_eq!(
            json!(record.match_id(&CRYPTO).map(|id| hex(id.as_bytes()))),
            field("match_id")
        );
        assert_eq!(
            json!(record.extra_player_id(&CRYPTO).map(|id| hex(id.as_bytes()))),
            field("extra_player_id")
        );
        assert_eq!(
            json!(record.sides().map(|sides| {
                sides
                    .iter()
                    .map(|side| side.iter().map(|p| hex(p.as_bytes())).collect::<Vec<_>>())
                    .collect::<Vec<_>>()
            })),
            field("sides")
        );
        assert_eq!(json!(record.terms().map(hex)), field("terms"));
        assert_eq!(json!(record.repeats_player()), field("repeats_player"));
        assert_eq!(key_hex(record.creator()), field("creator"));
        assert_eq!(key_hex(record.introduced_key()), field("introduced_key"));
        assert_eq!(
            json!(record.scored_match().map(|id| hex(id.as_bytes()))),
            field("scored_match")
        );
        assert_eq!(json!(record.slot()), field("slot"));
        assert_eq!(json!(record.value().map(hex)), field("value"));
        assert_eq!(
            json!(
                record
                    .replaces()
                    .map(|ids| { ids.iter().map(|id| hex(id.as_bytes())).collect::<Vec<_>>() })
            ),
            field("replaces")
        );
    }
    for entry in file["usernames"].as_array().unwrap() {
        let player: [u8; 32] = unhex(entry["player_id"].as_str().unwrap())
            .try_into()
            .unwrap();
        let length = entry["suffix_length"].as_u64().unwrap() as usize;
        assert_eq!(
            json!(PlayerId::from_bytes(player).username(length).unwrap()),
            entry["username"]
        );
    }
    for length in file["invalid_username_suffix_lengths"].as_array().unwrap() {
        let length = length.as_u64().unwrap() as usize;
        assert!(PlayerId::from_bytes([0; 32]).username(length).is_err());
    }
    for entry in file["invalid_records"].as_array().unwrap() {
        let bytes = unhex(entry["record"].as_str().unwrap());
        assert!(Record::decode(&bytes).is_err(), "{}", entry["name"]);
    }
    for entry in file["unverifiable_records"].as_array().unwrap() {
        let record = Record::decode(&unhex(entry["record"].as_str().unwrap())).unwrap();
        assert!(record.verify(&CRYPTO).is_err(), "{}", entry["name"]);
    }
    for entry in file["made_hellos"].as_array().unwrap() {
        let name = &entry["name"];
        let signer =
            PublicKey::from_sec1_compressed(&unhex(entry["signer"].as_str().unwrap())).unwrap();
        let random: [u8; 8] = unhex(entry["random"].as_str().unwrap()).try_into().unwrap();
        let clock = entry["clock"].as_u64().map(ClockReading::from_unix_millis);
        let environment = Environment(entry["environment"].as_u64().unwrap());
        let body = Draft::hello()
            .body(environment, signer, random, clock)
            .unwrap();
        assert_eq!(json!(hex(&body)), entry["body"], "{name}: body");
        let signature =
            Signature::from_raw(&unhex(entry["raw_signature"].as_str().unwrap())).unwrap();
        let record = Record::assemble_verified(body, signature, &CRYPTO).unwrap();
        assert_eq!(
            json!(hex(&record.to_bytes())),
            entry["record"],
            "{name}: record"
        );
        // Read back as a hello: it introduces its signer and names no match.
        assert_eq!(record.kind(), Some(Kind::Hello), "{name}: kind");
        assert_eq!(
            record.introduced_key(),
            Some(signer),
            "{name}: introduced key"
        );
        assert_eq!(record.signer(), signer, "{name}: signer");
        assert!(record.match_id(&CRYPTO).is_none(), "{name}: match id");
        assert!(record.sides().is_none(), "{name}: sides");
        assert!(record.terms().is_none(), "{name}: terms");
    }
    for entry in file["invalid_hello_inputs"].as_array().unwrap() {
        let signer = PublicKey::from_sec1_compressed(&unhex(entry["signer"].as_str().unwrap()));
        let random = <[u8; 8]>::try_from(unhex(entry["random"].as_str().unwrap()));
        assert!(signer.is_none() || random.is_err(), "{}", entry["name"]);
    }
    for entry in file["made_records"].as_array().unwrap() {
        let name = &entry["name"];
        let signer =
            PublicKey::from_sec1_compressed(&unhex(entry["signer"].as_str().unwrap())).unwrap();
        let random: [u8; 8] = unhex(entry["random"].as_str().unwrap()).try_into().unwrap();
        let clock = entry["clock"].as_u64().map(ClockReading::from_unix_millis);
        let environment = Environment(entry["environment"].as_u64().unwrap());
        let draft = draft_of(entry);
        let body = draft.body(environment, signer, random, clock).unwrap();
        assert_eq!(json!(hex(&body)), entry["body"], "{name}: body");
        let signature =
            Signature::from_raw(&unhex(entry["raw_signature"].as_str().unwrap())).unwrap();
        let record = Record::assemble_verified(body, signature, &CRYPTO).unwrap();
        assert_eq!(
            json!(hex(&record.to_bytes())),
            entry["record"],
            "{name}: record"
        );
        assert_eq!(
            json!(hex(record.id(&CRYPTO).as_bytes())),
            entry["id"],
            "{name}: id"
        );
        assert_eq!(
            json!(record.kind().map(Kind::name)),
            entry["kind_name"],
            "{name}: kind"
        );
    }
    for entry in file["parcels"].as_array().unwrap() {
        for form in ["text", "link"] {
            let parcel = Parcel::parse(entry[form].as_str().unwrap()).unwrap();
            assert_eq!(hex(&parcel.to_binary()), entry["binary"]);
            let records: Vec<String> = parcel
                .records()
                .iter()
                .map(|r| hex(&r.to_bytes()))
                .collect();
            assert_eq!(json!(records), entry["records"]);
        }
    }
    for entry in file["damaged_parcel_texts"].as_array().unwrap() {
        assert!(
            Parcel::parse(entry["text"].as_str().unwrap()).is_err(),
            "{}",
            entry["name"]
        );
    }
    for entry in file["signatures"].as_array().unwrap() {
        let stored = unhex(entry["stored"].as_str().unwrap());
        if let Some(der) = entry.get("der") {
            assert_eq!(
                Signature::from_der(&unhex(der.as_str().unwrap()))
                    .unwrap()
                    .as_bytes()
                    .as_slice(),
                stored
            );
        }
        assert_eq!(
            Signature::from_raw(&unhex(entry["raw"].as_str().unwrap()))
                .unwrap()
                .as_bytes()
                .as_slice(),
            stored
        );
    }
    for entry in file["invalid_der"].as_array().unwrap() {
        assert!(Signature::from_der(&unhex(entry["der"].as_str().unwrap())).is_err());
    }
    // The product layouts: each value gives its bytes and reads back from
    // them, and the unreadable bytes read as nothing.
    for entry in file["terms"].as_array().unwrap() {
        let best_of = u32::try_from(entry["best_of"].as_u64().unwrap()).unwrap();
        let terms = Terms::new(best_of, entry["rated"].as_bool().unwrap()).unwrap();
        assert_eq!(json!(hex(&terms.to_bytes())), entry["bytes"]);
        let bytes = unhex(entry["bytes"].as_str().unwrap());
        assert_eq!(Terms::read(&bytes), Some(terms));
    }
    for entry in file["unreadable_terms"].as_array().unwrap() {
        let bytes = unhex(entry["bytes"].as_str().unwrap());
        assert_eq!(Terms::read(&bytes), None, "{}", entry["name"]);
    }
    for best_of in file["invalid_best_ofs"].as_array().unwrap() {
        let best_of = u32::try_from(best_of.as_u64().unwrap()).unwrap();
        assert!(Terms::new(best_of, false).is_err(), "best of {best_of}");
    }
    for entry in file["score_values"].as_array().unwrap() {
        let value = match entry["score"].as_array() {
            Some(points) => ScoreValue::Points(
                [&points[0], &points[1]].map(|p| u32::try_from(p.as_u64().unwrap()).unwrap()),
            ),
            None => ScoreValue::Cleared,
        };
        assert_eq!(json!(hex(&value.to_bytes())), entry["bytes"]);
        let bytes = unhex(entry["bytes"].as_str().unwrap());
        assert_eq!(ScoreValue::read(&bytes), Some(value));
    }
    for entry in file["unreadable_score_values"].as_array().unwrap() {
        let bytes = unhex(entry["bytes"].as_str().unwrap());
        assert_eq!(ScoreValue::read(&bytes), None, "{}", entry["name"]);
    }
}
