//! Shared test support: software keys that sign (test code only; the library
//! never signs), a seeded random generator, and a fixed set of records.

#![allow(dead_code)]

use fortymm_core::cbor::{self, Value};
use fortymm_core::{
    ClockReading, Draft, Environment, GrantSide, GrantSubject, PlayerId, PublicKey, Record,
    Signature, Software, StaffFields, Stamp, Subject,
};
use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::Signer;

pub const CRYPTO: Software = Software;
pub const ENV: Environment = Environment::UAT;

/// A software P-256 key. Signs deterministically (RFC 6979), so the golden
/// vectors are reproducible.
pub struct TestKey {
    pub name: &'static str,
    pub signing: SigningKey,
}

impl TestKey {
    pub fn new(name: &'static str, fill: u8) -> TestKey {
        let signing = SigningKey::from_bytes(&[fill; 32].into()).expect("a valid scalar");
        TestKey { name, signing }
    }

    pub fn public(&self) -> PublicKey {
        let point = self.signing.verifying_key().to_encoded_point(true);
        PublicKey::from_sec1_compressed(point.as_bytes()).unwrap()
    }

    pub fn own_player(&self) -> PlayerId {
        self.public().own_player_id(&CRYPTO)
    }

    /// The platform's signature, as p256 returns it (not normalised).
    pub fn sign_platform(&self, message: &[u8]) -> p256::ecdsa::Signature {
        self.signing.sign(message)
    }

    /// The DER form, as the iOS Secure Enclave and the Android Keystore return.
    pub fn sign_der(&self, message: &[u8]) -> Vec<u8> {
        self.sign_platform(message).to_der().as_bytes().to_vec()
    }

    /// The raw r||s form, as WebCrypto returns.
    pub fn sign_raw(&self, message: &[u8]) -> Vec<u8> {
        self.sign_platform(message).to_bytes().to_vec()
    }

    /// What `commit` does on a platform: build the body, sign it, convert,
    /// assemble and check.
    pub fn commit(&self, draft: &Draft, random: [u8; 8], clock: Option<ClockReading>) -> Record {
        self.commit_in(ENV, draft, random, clock)
    }

    pub fn commit_in(
        &self,
        environment: Environment,
        draft: &Draft,
        random: [u8; 8],
        clock: Option<ClockReading>,
    ) -> Record {
        let body = draft
            .body(environment, self.public(), random, clock)
            .unwrap();
        let signature = Signature::from_der(&self.sign_der(&body)).unwrap();
        Record::assemble_verified(body, signature, &CRYPTO).unwrap()
    }

    /// Sign any body bytes, valid or not (for kinds the library does not
    /// build, and for invalid vectors).
    pub fn sign_body(&self, body: &[u8]) -> Signature {
        Signature::from_der(&self.sign_der(body)).unwrap()
    }
}

pub fn keys() -> [TestKey; 4] {
    [
        TestKey::new("alice", 0x11),
        TestKey::new("bob", 0x22),
        TestKey::new("carol", 0x33),
        TestKey::new("server", 0x44),
    ]
}

/// SplitMix64: seeded and reproducible.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    pub fn bytes(&mut self, count: usize) -> Vec<u8> {
        (0..count).map(|_| self.next() as u8).collect()
    }

    pub fn array8(&mut self) -> [u8; 8] {
        self.bytes(8).try_into().unwrap()
    }
}

/// The same signature with s replaced by n - s: valid ECDSA, but not the
/// stored form.
pub fn high_s(signature: &Signature) -> [u8; 64] {
    let parsed = p256::ecdsa::Signature::from_slice(signature.as_bytes()).unwrap();
    let (r, s) = parsed.split_scalars();
    let negated = p256::ecdsa::Signature::from_scalars(r, -*s).unwrap();
    negated.to_bytes().into()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

pub const STAMP: Stamp = Stamp([0x5a; 8]);

/// Terms used in the fixtures: 4 bytes, standing in for a terms layout
/// version and a few settings. The real layout is a product schema.
pub const TERMS: [u8; 4] = [0x01, 0x01, 0x05, 0x0b];

/// Result content used in the fixtures: 10 bytes, standing in for a content
/// layout version, how the match ended, the winning side and four game
/// scores. The real layout is a product schema.
pub const CONTENT: [u8; 10] = [0x01, 0x00, 0x00, 0x03, 11, 9, 7, 11, 11, 5];

/// One named record of every kind the library builds, plus records of kinds
/// it carries without interpreting.
pub struct Fixtures {
    pub keys: [TestKey; 4],
    pub records: Vec<(&'static str, Record)>,
}

impl Fixtures {
    pub fn get(&self, name: &str) -> &Record {
        &self
            .records
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("no fixture {name}"))
            .1
    }
}

pub fn random(index: u8) -> [u8; 8] {
    [index, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, index]
}

pub fn fixtures() -> Fixtures {
    let keys = keys();
    let [alice, bob, carol, server] = &keys;
    let mut records = Vec::new();

    let hello = alice.commit(&Draft::hello(), random(1), None);
    records.push(("hello", hello));

    let player = alice.commit(&Draft::player(), random(2), None);
    let extra = player.extra_player_id(&CRYPTO).unwrap();
    records.push(("player", player));

    let match_record = alice.commit(
        &Draft::match_(
            [vec![alice.own_player()], vec![bob.own_player()]],
            TERMS.to_vec(),
        )
        .unwrap(),
        random(3),
        None,
    );
    let match_id = match_record.match_id(&CRYPTO).unwrap();
    records.push(("match", match_record));

    let doubles = alice.commit(
        &Draft::match_(
            [
                vec![alice.own_player(), extra],
                vec![bob.own_player(), carol.own_player()],
            ],
            TERMS.to_vec(),
        )
        .unwrap(),
        random(4),
        Some(ClockReading::from_unix_millis(1_794_355_200_000)),
    );
    records.push(("match-doubles-with-clock", doubles));

    let score = alice.commit(
        &Draft::score(match_id, 1, vec![11, 9], vec![]),
        random(5),
        None,
    );
    let score_id = score.id(&CRYPTO);
    records.push(("score", score));
    let score2 = bob.commit(
        &Draft::score(match_id, 1, vec![11, 8], vec![score_id]),
        random(6),
        None,
    );
    records.push(("score-replacing", score2));

    let subject = Subject {
        match_id,
        seen: vec![],
        content: CONTENT.to_vec(),
    };
    let result_a = alice.commit(
        &Draft::result(subject.clone(), alice.own_player(), vec![]),
        random(7),
        None,
    );
    let outcome = result_a.outcome_id(&CRYPTO).unwrap();
    records.push(("result-first-side", result_a.clone()));
    // The second signer copies the subject out of the first record (R6).
    let copied = result_a.subject().unwrap().clone();
    let result_b = bob.commit(
        &Draft::result(copied, bob.own_player(), vec![]),
        random(8),
        None,
    );
    records.push(("result-second-side", result_b));

    let correction = Subject {
        match_id,
        seen: vec![outcome.tag()],
        content: vec![0x01, 0x00, 0x00, 0x03, 11, 9, 7, 11, 11, 6],
    };
    let ruling = carol.commit(&Draft::ruling(correction), random(9), None);
    records.push(("ruling", ruling));

    let close = server.commit(
        &Draft::close_match(match_id, Some(outcome.tag())),
        random(10),
        None,
    );
    records.push(("close-match", close));
    let close_none = server.commit(&Draft::close_match(match_id, None), random(11), None);
    records.push(("close-match-without-result", close_none));

    let grant_subject = GrantSubject {
        player: extra,
        receiver: bob.own_player(),
        leaver: Some(alice.own_player()),
        same_as: None,
        random: [0x77; 8],
    };
    let giving = alice.commit(
        &Draft::grant(grant_subject.clone(), GrantSide::Giving, STAMP),
        random(12),
        None,
    );
    records.push(("grant-giving", giving));
    let receiving = bob.commit(
        &Draft::grant(grant_subject, GrantSide::Receiving, STAMP),
        random(13),
        None,
    );
    records.push(("grant-receiving", receiving));

    let same = alice.commit(
        &Draft::same_person(alice.own_player(), extra, STAMP),
        random(14),
        None,
    );
    records.push(("same-person", same));
    let release = alice.commit(&Draft::release(extra, STAMP), random(15), None);
    records.push(("release", release));
    let revoke = alice.commit(&Draft::revoke(carol.public(), STAMP), random(16), None);
    records.push(("revoke", revoke));

    let staff = StaffFields {
        target: bob.own_player(),
        staff: carol.own_player(),
        reason: 3,
    };
    let suspend = server.commit(&Draft::suspend(staff.clone(), STAMP), random(17), None);
    records.push(("suspend", suspend));
    let reinstate = server.commit(&Draft::reinstate(staff, STAMP), random(18), None);
    records.push(("reinstate", reinstate));
    let clear = server.commit(
        &Draft::clear_name(
            StaffFields {
                target: extra,
                staff: carol.own_player(),
                reason: 1,
            },
            STAMP,
        ),
        random(19),
        None,
    );
    records.push(("clear-name", clear));

    // A kind no version of this library knows.
    records.push((
        "unknown-kind",
        raw_record(
            alice,
            1,
            999,
            ENV.0,
            random(20),
            vec![(8, Value::Bytes(vec![1, 2, 3])), (9, Value::Uint(7))],
        ),
    ));
    // A kind the design names but whose fields it does not settle.
    records.push((
        "name-not-interpreted",
        raw_record(
            alice,
            1,
            19,
            ENV.0,
            random(21),
            vec![
                (6, Value::Bytes(STAMP.0.to_vec())),
                (8, Value::Bytes(extra.as_bytes().to_vec())),
            ],
        ),
    ));
    // A known kind under a format version this library does not know.
    records.push((
        "future-format-version",
        raw_record(
            alice,
            2,
            5,
            ENV.0,
            random(22),
            vec![(7, Value::Uint(1)), (40, Value::Array(vec![]))],
        ),
    ));

    Fixtures { keys, records }
}

/// A body built field by field, signed by `key`.
pub fn raw_body(
    key: &TestKey,
    format_version: u64,
    kind: u64,
    environment: u64,
    random: [u8; 8],
    rest: Vec<(u64, Value)>,
) -> Vec<u8> {
    let mut entries = vec![
        (0, Value::Uint(format_version)),
        (1, Value::Uint(kind)),
        (2, Value::Uint(environment)),
        (3, Value::Bytes(key.public().as_bytes().to_vec())),
        (4, Value::Bytes(random.to_vec())),
    ];
    entries.extend(rest);
    cbor::encode(&Value::Map(entries))
}

pub fn raw_record(
    key: &TestKey,
    format_version: u64,
    kind: u64,
    environment: u64,
    random: [u8; 8],
    rest: Vec<(u64, Value)>,
) -> Record {
    let body = raw_body(key, format_version, kind, environment, random, rest);
    let signature = key.sign_body(&body);
    Record::assemble_verified(body, signature, &CRYPTO).unwrap()
}
