//! The golden vectors (design section 4.5, process 3): core/vectors/vectors.json, which every
//! build checks (this file for Rust, the web client's and the api's tests for wasm and Python).
//!
//! The file is produced by `build` below and checked against it. Before the first release it can
//! be regenerated; once released, a vector is never edited.

use fortymm_core::ids::label;
use fortymm_core::layout::username::MAX_SUFFIX_LENGTH;
use fortymm_core::{PlayerId, PublicKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value as Json, json};

const PATH: &str = "vectors/vectors.json";

/// A software P-256 key, from a fixed secret scalar, so the vectors are reproducible. The same
/// keys as the earlier core's vectors.
struct TestKey {
    name: &'static str,
    secret: p256::SecretKey,
}

impl TestKey {
    fn new(name: &'static str, fill: u8) -> TestKey {
        let secret = p256::SecretKey::from_bytes(&[fill; 32].into()).expect("a valid scalar");
        TestKey { name, secret }
    }

    /// The public half as WebCrypto exports it: 65 bytes, uncompressed.
    fn uncompressed(&self) -> Vec<u8> {
        self.secret
            .public_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    fn public(&self) -> PublicKey {
        PublicKey::from_sec1_uncompressed(&self.uncompressed()).unwrap()
    }
}

fn keys() -> Vec<TestKey> {
    vec![
        TestKey::new("alice", 0x11),
        TestKey::new("bob", 0x22),
        TestKey::new("carol", 0x33),
        TestKey::new("server", 0x44),
    ]
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// Uncompressed public keys that must be refused.
fn invalid_public_keys() -> Vec<Json> {
    let alice = TestKey::new("alice", 0x11).uncompressed();
    let mut off_curve = alice.clone();
    off_curve[64] ^= 1;
    let mut wrong_prefix = alice.clone();
    wrong_prefix[0] = 0x05;
    let mut infinity = vec![0u8; 65];
    infinity[0] = 0x04;
    vec![
        json!({"name": "off-the-curve", "public_key": hex(&off_curve)}),
        json!({"name": "wrong-prefix", "public_key": hex(&wrong_prefix)}),
        json!({"name": "all-zero", "public_key": hex(&infinity)}),
        json!({"name": "truncated", "public_key": hex(&alice[..64])}),
        json!({"name": "compressed", "public_key": hex(TestKey::new("alice", 0x11).public().as_bytes())}),
        json!({"name": "empty", "public_key": ""}),
    ]
}

fn build() -> Json {
    let keys = keys();

    // Generated usernames: every key's own player, and the two ends of the id range, at the
    // shortest suffix, one more, and the longest.
    let mut players: Vec<PlayerId> = keys.iter().map(|k| k.public().own_player_id()).collect();
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

    json!({
        "about": "FortyMM core golden vectors. Format choices are in core/FORMAT.md. Hex is lower case. uncompressed_public_key is the form WebCrypto exports; public_key is the 33-byte form records carry.",
        "labels": {
            "account": hex(label::ACCOUNT),
            "own_player": hex(label::OWN_PLAYER),
        },
        "keys": keys.iter().map(|k| json!({
            "name": k.name,
            "uncompressed_public_key": hex(&k.uncompressed()),
            "public_key": hex(k.public().as_bytes()),
            "account_id": hex(k.public().account_id().as_bytes()),
            "own_player_id": hex(k.public().own_player_id().as_bytes()),
        })).collect::<Vec<_>>(),
        "invalid_uncompressed_public_keys": invalid_public_keys(),
        "usernames": usernames,
        "invalid_username_suffix_lengths": [0, 1, 3, MAX_SUFFIX_LENGTH + 1],
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

/// The vectors checked the way another build checks them: from the file alone.
#[test]
fn vectors_check_from_the_file_alone() {
    let file: Json =
        serde_json::from_str(&std::fs::read_to_string(PATH).expect("vectors/vectors.json exists"))
            .unwrap();
    for entry in file["keys"].as_array().unwrap() {
        let key = PublicKey::from_sec1_uncompressed(&unhex(
            entry["uncompressed_public_key"].as_str().unwrap(),
        ))
        .unwrap();
        assert_eq!(json!(hex(key.as_bytes())), entry["public_key"]);
        assert_eq!(json!(hex(key.account_id().as_bytes())), entry["account_id"]);
        assert_eq!(
            json!(hex(key.own_player_id().as_bytes())),
            entry["own_player_id"]
        );
    }
    for entry in file["invalid_uncompressed_public_keys"].as_array().unwrap() {
        let bytes = unhex(entry["public_key"].as_str().unwrap());
        assert!(
            PublicKey::from_sec1_uncompressed(&bytes).is_err(),
            "{}",
            entry["name"]
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
}
