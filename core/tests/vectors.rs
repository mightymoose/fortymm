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

use common::{CRYPTO, ENV, fixtures, hex, high_s, random, raw_body};
use fortymm_core::cbor::Value;
use fortymm_core::ids::label;
use fortymm_core::parcel::checksum;
use fortymm_core::{Content, Draft, Kind, Parcel, Record, Signature};
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
    if let Some(subject) = record.subject() {
        let outcome = subject.outcome_id(&CRYPTO);
        object.insert("subject".into(), json!(hex(&subject.to_bytes())));
        object.insert("outcome_id".into(), json!(hex(outcome.as_bytes())));
        object.insert("tag".into(), json!(hex(outcome.tag().as_bytes())));
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

    let checksums: Vec<Json> = [b"".as_slice(), b"123456789", b"\x00", b"\xff\xff\xff\xff"]
        .iter()
        .map(|input| json!({"input": hex(input), "checksum": format!("{:08x}", checksum(input))}))
        .collect();

    json!({
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
        "parcels": parcels,
        "damaged_parcel_texts": damaged,
        "harmless_parcel_texts": harmless,
        "signatures": signatures,
        "invalid_der": bad_der,
        "checksums": checksums,
    })
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
    }
    for entry in file["invalid_records"].as_array().unwrap() {
        let bytes = unhex(entry["record"].as_str().unwrap());
        assert!(Record::decode(&bytes).is_err(), "{}", entry["name"]);
    }
    for entry in file["unverifiable_records"].as_array().unwrap() {
        let record = Record::decode(&unhex(entry["record"].as_str().unwrap())).unwrap();
        assert!(record.verify(&CRYPTO).is_err(), "{}", entry["name"]);
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
}
