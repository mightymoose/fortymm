//! Records: the body layout, the typed constructor for each kind, strict
//! decoding, and signature verification (design section 4).
//!
//! A body is a CBOR map (see [`crate::cbor`]). Keys 0 to 6 are the header and
//! mean the same thing in every kind; keys from 8 up are the kind's own
//! fields. The layout of each key and kind is in FORMAT.md.
//!
//! A body of a kind this library does not interpret, or of another format
//! version, still decodes as far as the header: its remaining fields are kept
//! as [`Content::Other`], it verifies like any other record, and it is carried
//! in a parcel unchanged (design section 10, "Server does not yet understand
//! the kind").

use std::fmt;

use crate::cbor::{self, CborError, Value};
use crate::crypto::Crypto;
use crate::ids::{self, AccountId, MatchId, OutcomeId, PlayerId, PublicKey, RecordId, Tag};
use crate::layout::{self, field, grant_side, grant_subject, header as key, kind as number};
use crate::signature::{Signature, SignatureError};

/// The largest body this library accepts. Chosen by this implementation; the
/// design sets no maximum (FORMAT.md, "Limits").
pub const MAX_BODY_LENGTH: usize = 4096;

/// Which deployment a record or parcel was made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Environment(pub u64);

impl Environment {
    /// Production.
    pub const PRODUCTION: Environment = Environment(layout::environment::PRODUCTION);
    /// User acceptance testing.
    pub const UAT: Environment = Environment(layout::environment::UAT);
    /// A developer's own stack.
    pub const DEVELOPMENT: Environment = Environment(layout::environment::DEVELOPMENT);
}

/// A stamp issued by the server (design section 8.3).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Stamp(pub [u8; layout::STAMP_LENGTH]);

impl fmt::Debug for Stamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Stamp({})", crate::hex::encode(&self.0))
    }
}

/// The device's clock when it made the record, in milliseconds since the Unix
/// epoch. Display only: the type has no comparison or ordering operations
/// (design section 4.2, "A decision based on a device clock").
#[derive(Clone, Copy)]
pub struct ClockReading(u64);

impl ClockReading {
    /// From milliseconds since the Unix epoch.
    pub const fn from_unix_millis(millis: u64) -> ClockReading {
        ClockReading(millis)
    }

    /// Milliseconds since the Unix epoch, for display.
    pub const fn unix_millis(self) -> u64 {
        self.0
    }
}

impl fmt::Debug for ClockReading {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ClockReading({})", self.0)
    }
}

/// Every kind the design names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// `hello`: introduces a key.
    Hello,
    /// `player`: creates an extra player.
    Player,
    /// `match`: creates a match.
    Match,
    /// `score`: a temporary score.
    Score,
    /// `result`: one party's signature on an outcome.
    Result,
    /// `ruling`: an official's decision.
    Ruling,
    /// `close` in section 4: closes a match.
    CloseMatch,
    /// `grant`: one party's signature on a grant.
    Grant,
    /// `attach-email`. Not interpreted: see FORMAT.md, "Kinds left generic".
    AttachEmail,
    /// `join`. Not interpreted.
    Join,
    /// `same-person`.
    SamePerson,
    /// `name`. Not interpreted.
    Name,
    /// `release`.
    Release,
    /// `revoke`.
    Revoke,
    /// `change-email`. Not interpreted.
    ChangeEmail,
    /// `close` in section 8.3: closes an account. Not interpreted.
    CloseAccount,
    /// `suspend`.
    Suspend,
    /// `reinstate`.
    Reinstate,
    /// `clear-name`.
    ClearName,
}

impl Kind {
    /// Every kind, in number order.
    pub const ALL: [Kind; 19] = [
        Kind::Hello,
        Kind::Player,
        Kind::Match,
        Kind::Score,
        Kind::Result,
        Kind::Ruling,
        Kind::CloseMatch,
        Kind::Grant,
        Kind::AttachEmail,
        Kind::Join,
        Kind::SamePerson,
        Kind::Name,
        Kind::Release,
        Kind::Revoke,
        Kind::ChangeEmail,
        Kind::CloseAccount,
        Kind::Suspend,
        Kind::Reinstate,
        Kind::ClearName,
    ];

    /// The number in the body.
    pub const fn number(self) -> u64 {
        match self {
            Kind::Hello => number::HELLO,
            Kind::Player => number::PLAYER,
            Kind::Match => number::MATCH,
            Kind::Score => number::SCORE,
            Kind::Result => number::RESULT,
            Kind::Ruling => number::RULING,
            Kind::CloseMatch => number::CLOSE_MATCH,
            Kind::Grant => number::GRANT,
            Kind::AttachEmail => number::ATTACH_EMAIL,
            Kind::Join => number::JOIN,
            Kind::SamePerson => number::SAME_PERSON,
            Kind::Name => number::NAME,
            Kind::Release => number::RELEASE,
            Kind::Revoke => number::REVOKE,
            Kind::ChangeEmail => number::CHANGE_EMAIL,
            Kind::CloseAccount => number::CLOSE_ACCOUNT,
            Kind::Suspend => number::SUSPEND,
            Kind::Reinstate => number::REINSTATE,
            Kind::ClearName => number::CLEAR_NAME,
        }
    }

    /// The kind with this number, if the design names one.
    pub fn from_number(value: u64) -> Option<Kind> {
        Kind::ALL.into_iter().find(|kind| kind.number() == value)
    }

    /// The name in code. The design calls both `CloseMatch` and
    /// `CloseAccount` "close".
    pub const fn name(self) -> &'static str {
        match self {
            Kind::Hello => "hello",
            Kind::Player => "player",
            Kind::Match => "match",
            Kind::Score => "score",
            Kind::Result => "result",
            Kind::Ruling => "ruling",
            Kind::CloseMatch => "close-match",
            Kind::Grant => "grant",
            Kind::AttachEmail => "attach-email",
            Kind::Join => "join",
            Kind::SamePerson => "same-person",
            Kind::Name => "name",
            Kind::Release => "release",
            Kind::Revoke => "revoke",
            Kind::ChangeEmail => "change-email",
            Kind::CloseAccount => "close-account",
            Kind::Suspend => "suspend",
            Kind::Reinstate => "reinstate",
            Kind::ClearName => "clear-name",
        }
    }

    /// Whether the kind is an identity request (design section 8.3).
    pub const fn is_request(self) -> bool {
        matches!(
            self,
            Kind::AttachEmail
                | Kind::Join
                | Kind::SamePerson
                | Kind::Name
                | Kind::Release
                | Kind::Revoke
                | Kind::ChangeEmail
                | Kind::CloseAccount
                | Kind::Suspend
                | Kind::Reinstate
                | Kind::ClearName
        )
    }

    /// Whether the kind carries a stamp: a grant and every request (design
    /// sections 4 and 8.3).
    pub const fn carries_stamp(self) -> bool {
        matches!(self, Kind::Grant) || self.is_request()
    }

    /// Whether this library decodes the kind's fields. The others are kept as
    /// [`Content::Other`] because the design does not yet say what they hold.
    pub const fn is_interpreted(self) -> bool {
        !matches!(
            self,
            Kind::AttachEmail | Kind::Join | Kind::Name | Kind::ChangeEmail | Kind::CloseAccount
        )
    }
}

/// The five fields every body starts with, and the two optional header
/// fields.
#[derive(Clone, Debug)]
pub struct Header {
    /// The format version.
    pub format_version: u64,
    /// The kind number. [`Kind::from_number`] names it, if it is known.
    pub kind: u64,
    /// The environment.
    pub environment: Environment,
    /// The signer's public key.
    pub signer: PublicKey,
    /// The random value.
    pub random: [u8; layout::RANDOM_LENGTH],
    /// The device's clock, if the signer included it.
    pub clock: Option<ClockReading>,
    /// The stamp, in the kinds that carry one.
    pub stamp: Option<Stamp>,
}

/// The subject of a `result` or a `ruling`: what every side signs, and what
/// the outcome id is computed from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subject {
    /// The match.
    pub match_id: MatchId,
    /// The tags of the outcomes the signers had seen, oldest first.
    pub seen: Vec<Tag>,
    /// The result content. Opaque here; its layout is a product schema.
    pub content: Vec<u8>,
}

impl Subject {
    fn to_value(&self) -> Value {
        Value::Array(vec![
            id_value(self.match_id.as_bytes()),
            Value::Array(
                self.seen
                    .iter()
                    .map(|tag| id_value(tag.as_bytes()))
                    .collect(),
            ),
            Value::Bytes(self.content.clone()),
        ])
    }

    /// The subject's bytes, exactly as they appear inside the record.
    pub fn to_bytes(&self) -> Vec<u8> {
        cbor::encode(&self.to_value())
    }

    /// The preimage of the outcome id, for a host that hashes by itself.
    pub fn outcome_id_preimage(&self) -> Vec<u8> {
        ids::outcome_id_preimage(&self.to_bytes())
    }

    /// The id of the outcome this subject creates.
    pub fn outcome_id(&self, crypto: &impl Crypto) -> OutcomeId {
        ids::outcome_id(crypto, &self.to_bytes())
    }
}

/// The subject of a grant (design section 8.3): what both accounts sign.
///
/// An account is named by one of its players, because a record never holds an
/// account id (design sections 4.3 and 8.3, "Email proof").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantSubject {
    /// The player being granted.
    pub player: PlayerId,
    /// A player of the receiving account.
    pub receiver: PlayerId,
    /// A player of the account that leaves, if one does.
    pub leaver: Option<PlayerId>,
    /// The receiver's player that this one becomes the same as, if any.
    pub same_as: Option<PlayerId>,
    /// The random value chosen by whoever signs first.
    pub random: [u8; layout::RANDOM_LENGTH],
}

impl GrantSubject {
    fn to_value(&self) -> Value {
        let mut entries = vec![
            (grant_subject::PLAYER, id_value(self.player.as_bytes())),
            (grant_subject::RECEIVER, id_value(self.receiver.as_bytes())),
        ];
        if let Some(leaver) = &self.leaver {
            entries.push((grant_subject::LEAVER, id_value(leaver.as_bytes())));
        }
        if let Some(same_as) = &self.same_as {
            entries.push((grant_subject::SAME_AS, id_value(same_as.as_bytes())));
        }
        entries.push((grant_subject::RANDOM, id_value(&self.random)));
        Value::Map(entries)
    }

    /// The subject's bytes, exactly as they appear inside the record.
    pub fn to_bytes(&self) -> Vec<u8> {
        cbor::encode(&self.to_value())
    }
}

/// Which side of a grant a signature is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantSide {
    /// The manager who gives the player.
    Giving,
    /// The account that receives it.
    Receiving,
}

/// The fields of a staff action: the account (or, for `clear-name`, the
/// player) it acts on, the staff member, and a reason code (design section
/// 8.3, "Staff actions").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaffFields {
    /// For `suspend` and `reinstate`, the own player of the account. For
    /// `clear-name`, the player whose name is cleared.
    pub target: PlayerId,
    /// The staff member's own player.
    pub staff: PlayerId,
    /// The reason code. Its values are a parameter.
    pub reason: u64,
}

/// A body's fields after the header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Content {
    /// `hello`.
    Hello,
    /// `player`.
    Player,
    /// `match`.
    Match {
        /// The two sides, each one or more players.
        sides: [Vec<PlayerId>; 2],
        /// The terms. Opaque here; their layout is a product schema.
        terms: Vec<u8>,
    },
    /// `score`.
    Score {
        /// The match.
        match_id: MatchId,
        /// 0 for the whole match, n for game n.
        slot: u64,
        /// The score. Opaque here.
        value: Vec<u8>,
        /// The `score` records this one replaces.
        replaces: Vec<RecordId>,
    },
    /// `result`.
    Result {
        /// What every side signs.
        subject: Subject,
        /// The player the signature is given for.
        player: PlayerId,
        /// The signer's earlier `result` records this one supersedes.
        /// Display only.
        supersedes: Vec<RecordId>,
    },
    /// `ruling`.
    Ruling {
        /// What the official decided.
        subject: Subject,
    },
    /// `close` for a match.
    CloseMatch {
        /// The match.
        match_id: MatchId,
        /// The tag of the official result when it was closed, if any.
        official: Option<Tag>,
    },
    /// `grant`.
    Grant {
        /// What both accounts sign.
        subject: GrantSubject,
        /// The side this signature is for.
        side: GrantSide,
    },
    /// `same-person`.
    SamePerson {
        /// One player.
        first: PlayerId,
        /// The other.
        second: PlayerId,
    },
    /// `release`.
    Release {
        /// The player the signer's account stops managing.
        player: PlayerId,
    },
    /// `revoke`.
    Revoke {
        /// The key that stops speaking for anything.
        key: PublicKey,
    },
    /// `suspend`.
    Suspend(StaffFields),
    /// `reinstate`.
    Reinstate(StaffFields),
    /// `clear-name`.
    ClearName(StaffFields),
    /// The fields of a kind this library does not interpret, or of a format
    /// version it does not know: every entry with a key above the header's,
    /// kept as it was.
    Other(Vec<(u64, Value)>),
}

impl Content {
    /// The kind this content belongs to, or `None` for [`Content::Other`].
    pub fn kind(&self) -> Option<Kind> {
        Some(match self {
            Content::Hello => Kind::Hello,
            Content::Player => Kind::Player,
            Content::Match { .. } => Kind::Match,
            Content::Score { .. } => Kind::Score,
            Content::Result { .. } => Kind::Result,
            Content::Ruling { .. } => Kind::Ruling,
            Content::CloseMatch { .. } => Kind::CloseMatch,
            Content::Grant { .. } => Kind::Grant,
            Content::SamePerson { .. } => Kind::SamePerson,
            Content::Release { .. } => Kind::Release,
            Content::Revoke { .. } => Kind::Revoke,
            Content::Suspend(_) => Kind::Suspend,
            Content::Reinstate(_) => Kind::Reinstate,
            Content::ClearName(_) => Kind::ClearName,
            Content::Other(_) => return None,
        })
    }

    /// Every match and player id the content names.
    pub fn referenced_ids(&self) -> Vec<[u8; 32]> {
        match self {
            Content::Hello | Content::Player | Content::Revoke { .. } | Content::Other(_) => {
                vec![]
            }
            Content::Match { sides, .. } => sides
                .iter()
                .flatten()
                .map(|player| *player.as_bytes())
                .collect(),
            Content::Score { match_id, .. } | Content::CloseMatch { match_id, .. } => {
                vec![*match_id.as_bytes()]
            }
            Content::Result {
                subject, player, ..
            } => vec![*subject.match_id.as_bytes(), *player.as_bytes()],
            Content::Ruling { subject } => vec![*subject.match_id.as_bytes()],
            Content::Grant { subject, .. } => [
                Some(subject.player),
                Some(subject.receiver),
                subject.leaver,
                subject.same_as,
            ]
            .into_iter()
            .flatten()
            .map(|player| *player.as_bytes())
            .collect(),
            Content::SamePerson { first, second } => vec![*first.as_bytes(), *second.as_bytes()],
            Content::Release { player } => vec![*player.as_bytes()],
            Content::Suspend(staff) | Content::Reinstate(staff) | Content::ClearName(staff) => {
                vec![*staff.target.as_bytes(), *staff.staff.as_bytes()]
            }
        }
    }

    fn fields(&self) -> Vec<(u64, Value)> {
        let ids = |list: &[RecordId]| {
            Value::Array(list.iter().map(|id| id_value(id.as_bytes())).collect())
        };
        match self {
            Content::Hello | Content::Player => vec![],
            Content::Match { sides, terms } => vec![
                (
                    field::match_::SIDES,
                    Value::Array(
                        sides
                            .iter()
                            .map(|side| {
                                Value::Array(side.iter().map(|p| id_value(p.as_bytes())).collect())
                            })
                            .collect(),
                    ),
                ),
                (field::match_::TERMS, Value::Bytes(terms.clone())),
            ],
            Content::Score {
                match_id,
                slot,
                value,
                replaces,
            } => vec![
                (field::score::MATCH, id_value(match_id.as_bytes())),
                (field::score::SLOT, Value::Uint(*slot)),
                (field::score::VALUE, Value::Bytes(value.clone())),
                (field::score::REPLACES, ids(replaces)),
            ],
            Content::Result {
                subject,
                player,
                supersedes,
            } => vec![
                (field::result::SUBJECT, subject.to_value()),
                (field::result::PLAYER, id_value(player.as_bytes())),
                (field::result::SUPERSEDES, ids(supersedes)),
            ],
            Content::Ruling { subject } => vec![(field::ruling::SUBJECT, subject.to_value())],
            Content::CloseMatch { match_id, official } => {
                let mut fields = vec![(field::close_match::MATCH, id_value(match_id.as_bytes()))];
                if let Some(tag) = official {
                    fields.push((field::close_match::OFFICIAL, id_value(tag.as_bytes())));
                }
                fields
            }
            Content::Grant { subject, side } => vec![
                (field::grant::SUBJECT, subject.to_value()),
                (
                    field::grant::SIDE,
                    Value::Uint(match side {
                        GrantSide::Giving => grant_side::GIVING,
                        GrantSide::Receiving => grant_side::RECEIVING,
                    }),
                ),
            ],
            Content::SamePerson { first, second } => vec![
                (field::same_person::FIRST, id_value(first.as_bytes())),
                (field::same_person::SECOND, id_value(second.as_bytes())),
            ],
            Content::Release { player } => {
                vec![(field::release::PLAYER, id_value(player.as_bytes()))]
            }
            Content::Revoke { key } => vec![(field::revoke::KEY, id_value(key.as_bytes()))],
            Content::Suspend(staff) | Content::Reinstate(staff) | Content::ClearName(staff) => {
                vec![
                    (field::staff::ACCOUNT, id_value(staff.target.as_bytes())),
                    (field::staff::STAFF, id_value(staff.staff.as_bytes())),
                    (field::staff::REASON, Value::Uint(staff.reason)),
                ]
            }
            Content::Other(entries) => entries.clone(),
        }
    }
}

fn id_value(bytes: &[u8]) -> Value {
    Value::Bytes(bytes.to_vec())
}

fn encode_body(header: &Header, content: &Content) -> Vec<u8> {
    let mut entries = vec![
        (key::FORMAT_VERSION, Value::Uint(header.format_version)),
        (key::KIND, Value::Uint(header.kind)),
        (key::ENVIRONMENT, Value::Uint(header.environment.0)),
        (key::SIGNER, id_value(header.signer.as_bytes())),
        (key::RANDOM, id_value(&header.random)),
    ];
    if let Some(clock) = header.clock {
        entries.push((key::CLOCK, Value::Uint(clock.0)));
    }
    if let Some(stamp) = header.stamp {
        entries.push((key::STAMP, id_value(&stamp.0)));
    }
    entries.extend(content.fields());
    cbor::encode(&Value::Map(entries))
}

/// Why bytes are not a record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordError {
    /// The bytes are not a value of the CBOR profile.
    Cbor(CborError),
    /// The body is longer than [`MAX_BODY_LENGTH`].
    TooLarge,
    /// The body is not a map, or a standalone record is not a pair of byte
    /// strings.
    NotARecord,
    /// A required field is missing. Holds its key.
    MissingField(u64),
    /// A field this kind does not have. Holds its key.
    UnexpectedField(u64),
    /// A field of the wrong type, length or value. Holds its key.
    BadField(u64),
    /// The signature is not in the stored form.
    Signature(SignatureError),
    /// The body re-encodes to different bytes. The strict decoder makes this
    /// unreachable; the check stays as a second guard for R2.
    NotCanonical,
}

impl fmt::Display for RecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecordError::Cbor(error) => write!(f, "not canonical CBOR: {error}"),
            RecordError::TooLarge => write!(f, "the body is longer than {MAX_BODY_LENGTH} bytes"),
            RecordError::NotARecord => write!(f, "not a record"),
            RecordError::MissingField(key) => write!(f, "field {key} is missing"),
            RecordError::UnexpectedField(key) => write!(f, "field {key} is not allowed here"),
            RecordError::BadField(key) => write!(f, "field {key} is malformed"),
            RecordError::Signature(error) => write!(f, "bad signature encoding: {error}"),
            RecordError::NotCanonical => write!(f, "the body does not re-encode identically"),
        }
    }
}

impl std::error::Error for RecordError {}

impl From<CborError> for RecordError {
    fn from(error: CborError) -> Self {
        RecordError::Cbor(error)
    }
}

/// Map entries, taken in ascending key order.
struct Fields {
    entries: std::iter::Peekable<std::vec::IntoIter<(u64, Value)>>,
}

impl Fields {
    fn optional(&mut self, wanted: u64) -> Option<Value> {
        self.entries
            .next_if(|(key, _)| *key == wanted)
            .map(|(_, value)| value)
    }

    fn required(&mut self, wanted: u64) -> Result<Value, RecordError> {
        self.optional(wanted)
            .ok_or(RecordError::MissingField(wanted))
    }

    fn finish(mut self) -> Result<(), RecordError> {
        match self.entries.next() {
            Some((key, _)) => Err(RecordError::UnexpectedField(key)),
            None => Ok(()),
        }
    }

    fn rest(self) -> Vec<(u64, Value)> {
        self.entries.collect()
    }
}

fn uint(value: Value, key: u64) -> Result<u64, RecordError> {
    match value {
        Value::Uint(n) => Ok(n),
        _ => Err(RecordError::BadField(key)),
    }
}

fn bytes(value: Value, key: u64) -> Result<Vec<u8>, RecordError> {
    match value {
        Value::Bytes(bytes) => Ok(bytes),
        _ => Err(RecordError::BadField(key)),
    }
}

fn fixed<const N: usize>(value: Value, key: u64) -> Result<[u8; N], RecordError> {
    bytes(value, key)?
        .try_into()
        .map_err(|_| RecordError::BadField(key))
}

fn array(value: Value, key: u64) -> Result<Vec<Value>, RecordError> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(RecordError::BadField(key)),
    }
}

fn player(value: Value, key: u64) -> Result<PlayerId, RecordError> {
    Ok(PlayerId::from_bytes(fixed(value, key)?))
}

fn record_ids(value: Value, key: u64) -> Result<Vec<RecordId>, RecordError> {
    array(value, key)?
        .into_iter()
        .map(|item| Ok(RecordId::from_bytes(fixed(item, key)?)))
        .collect()
}

fn subject(value: Value, key: u64) -> Result<Subject, RecordError> {
    let [match_id, seen, content]: [Value; 3] = array(value, key)?
        .try_into()
        .map_err(|_| RecordError::BadField(key))?;
    Ok(Subject {
        match_id: MatchId::from_bytes(fixed(match_id, key)?),
        seen: array(seen, key)?
            .into_iter()
            .map(|tag| Ok(Tag::from_bytes(fixed(tag, key)?)))
            .collect::<Result<_, RecordError>>()?,
        content: bytes(content, key)?,
    })
}

fn grant_subject_from(value: Value, key: u64) -> Result<GrantSubject, RecordError> {
    let Value::Map(entries) = value else {
        return Err(RecordError::BadField(key));
    };
    let mut fields = Fields {
        entries: entries.into_iter().peekable(),
    };
    let bad = |_| RecordError::BadField(key);
    let subject = GrantSubject {
        player: player(fields.required(grant_subject::PLAYER).map_err(bad)?, key)?,
        receiver: player(fields.required(grant_subject::RECEIVER).map_err(bad)?, key)?,
        leaver: fields
            .optional(grant_subject::LEAVER)
            .map(|value| player(value, key))
            .transpose()?,
        same_as: fields
            .optional(grant_subject::SAME_AS)
            .map(|value| player(value, key))
            .transpose()?,
        random: fixed(fields.required(grant_subject::RANDOM).map_err(bad)?, key)?,
    };
    fields.finish().map_err(bad)?;
    Ok(subject)
}

fn staff(fields: &mut Fields) -> Result<StaffFields, RecordError> {
    Ok(StaffFields {
        target: player(
            fields.required(field::staff::ACCOUNT)?,
            field::staff::ACCOUNT,
        )?,
        staff: player(fields.required(field::staff::STAFF)?, field::staff::STAFF)?,
        reason: uint(fields.required(field::staff::REASON)?, field::staff::REASON)?,
    })
}

fn decode_content(kind: Kind, fields: &mut Fields) -> Result<Content, RecordError> {
    Ok(match kind {
        Kind::Hello => Content::Hello,
        Kind::Player => Content::Player,
        Kind::Match => {
            let sides_key = field::match_::SIDES;
            let sides: [Value; 2] = array(fields.required(sides_key)?, sides_key)?
                .try_into()
                .map_err(|_| RecordError::BadField(sides_key))?;
            let [first, second] = sides.map(|side| {
                let players = array(side, sides_key)?
                    .into_iter()
                    .map(|item| player(item, sides_key))
                    .collect::<Result<Vec<_>, _>>()?;
                if players.is_empty() {
                    return Err(RecordError::BadField(sides_key));
                }
                Ok(players)
            });
            Content::Match {
                sides: [first?, second?],
                terms: bytes(fields.required(field::match_::TERMS)?, field::match_::TERMS)?,
            }
        }
        Kind::Score => Content::Score {
            match_id: MatchId::from_bytes(fixed(
                fields.required(field::score::MATCH)?,
                field::score::MATCH,
            )?),
            slot: uint(fields.required(field::score::SLOT)?, field::score::SLOT)?,
            value: bytes(fields.required(field::score::VALUE)?, field::score::VALUE)?,
            replaces: record_ids(
                fields.required(field::score::REPLACES)?,
                field::score::REPLACES,
            )?,
        },
        Kind::Result => Content::Result {
            subject: subject(
                fields.required(field::result::SUBJECT)?,
                field::result::SUBJECT,
            )?,
            player: player(
                fields.required(field::result::PLAYER)?,
                field::result::PLAYER,
            )?,
            supersedes: record_ids(
                fields.required(field::result::SUPERSEDES)?,
                field::result::SUPERSEDES,
            )?,
        },
        Kind::Ruling => Content::Ruling {
            subject: subject(
                fields.required(field::ruling::SUBJECT)?,
                field::ruling::SUBJECT,
            )?,
        },
        Kind::CloseMatch => Content::CloseMatch {
            match_id: MatchId::from_bytes(fixed(
                fields.required(field::close_match::MATCH)?,
                field::close_match::MATCH,
            )?),
            official: fields
                .optional(field::close_match::OFFICIAL)
                .map(|value| fixed(value, field::close_match::OFFICIAL).map(Tag::from_bytes))
                .transpose()?,
        },
        Kind::Grant => Content::Grant {
            subject: grant_subject_from(
                fields.required(field::grant::SUBJECT)?,
                field::grant::SUBJECT,
            )?,
            side: match uint(fields.required(field::grant::SIDE)?, field::grant::SIDE)? {
                grant_side::GIVING => GrantSide::Giving,
                grant_side::RECEIVING => GrantSide::Receiving,
                _ => return Err(RecordError::BadField(field::grant::SIDE)),
            },
        },
        Kind::SamePerson => Content::SamePerson {
            first: player(
                fields.required(field::same_person::FIRST)?,
                field::same_person::FIRST,
            )?,
            second: player(
                fields.required(field::same_person::SECOND)?,
                field::same_person::SECOND,
            )?,
        },
        Kind::Release => Content::Release {
            player: player(
                fields.required(field::release::PLAYER)?,
                field::release::PLAYER,
            )?,
        },
        Kind::Revoke => Content::Revoke {
            key: PublicKey::from_sec1_compressed(&bytes(
                fields.required(field::revoke::KEY)?,
                field::revoke::KEY,
            )?)
            .ok_or(RecordError::BadField(field::revoke::KEY))?,
        },
        Kind::Suspend => Content::Suspend(staff(fields)?),
        Kind::Reinstate => Content::Reinstate(staff(fields)?),
        Kind::ClearName => Content::ClearName(staff(fields)?),
        Kind::AttachEmail | Kind::Join | Kind::Name | Kind::ChangeEmail | Kind::CloseAccount => {
            unreachable!("kinds that are not interpreted are decoded as Content::Other")
        }
    })
}

fn decode_body(body: &[u8]) -> Result<(Header, Content), RecordError> {
    if body.len() > MAX_BODY_LENGTH {
        return Err(RecordError::TooLarge);
    }
    let Value::Map(entries) = cbor::decode(body)? else {
        return Err(RecordError::NotARecord);
    };
    let mut fields = Fields {
        entries: entries.into_iter().peekable(),
    };
    let header = Header {
        format_version: uint(fields.required(key::FORMAT_VERSION)?, key::FORMAT_VERSION)?,
        kind: uint(fields.required(key::KIND)?, key::KIND)?,
        environment: Environment(uint(fields.required(key::ENVIRONMENT)?, key::ENVIRONMENT)?),
        signer: PublicKey::from_sec1_compressed(&bytes(
            fields.required(key::SIGNER)?,
            key::SIGNER,
        )?)
        .ok_or(RecordError::BadField(key::SIGNER))?,
        random: fixed(fields.required(key::RANDOM)?, key::RANDOM)?,
        clock: fields
            .optional(key::CLOCK)
            .map(|value| uint(value, key::CLOCK).map(ClockReading))
            .transpose()?,
        stamp: fields
            .optional(key::STAMP)
            .map(|value| fixed(value, key::STAMP).map(Stamp))
            .transpose()?,
    };
    let interpreted = Kind::from_number(header.kind)
        .filter(|kind| header.format_version == layout::FORMAT_VERSION && kind.is_interpreted());
    let content = match interpreted {
        Some(kind) => {
            match (kind.carries_stamp(), header.stamp.is_some()) {
                (true, false) => return Err(RecordError::MissingField(key::STAMP)),
                (false, true) => return Err(RecordError::UnexpectedField(key::STAMP)),
                _ => {}
            }
            let content = decode_content(kind, &mut fields)?;
            fields.finish()?;
            content
        }
        None => Content::Other(fields.rest()),
    };
    if encode_body(&header, &content) != body {
        return Err(RecordError::NotCanonical);
    }
    Ok((header, content))
}

/// What a draft is missing or has wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftError {
    /// A match side with no players.
    EmptySide,
    /// The body would be longer than [`MAX_BODY_LENGTH`].
    TooLarge,
}

impl fmt::Display for DraftError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DraftError::EmptySide => write!(f, "each side of a match needs a player"),
            DraftError::TooLarge => write!(f, "the body would be too large"),
        }
    }
}

impl std::error::Error for DraftError {}

/// A record's content before it has a header: what feature code builds,
/// through one constructor per kind (design section 4.3).
///
/// [`Draft::body`] adds the header and returns the bytes to sign. The random
/// value is a parameter, because the core has no random generator: the
/// platform passes in 8 bytes from its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    content: Content,
    stamp: Option<Stamp>,
}

impl Draft {
    /// A `hello`.
    pub fn hello() -> Draft {
        Draft::plain(Content::Hello)
    }

    /// A `player`.
    pub fn player() -> Draft {
        Draft::plain(Content::Player)
    }

    /// A `match`. Each side needs at least one player.
    pub fn match_(sides: [Vec<PlayerId>; 2], terms: Vec<u8>) -> Result<Draft, DraftError> {
        if sides.iter().any(Vec::is_empty) {
            return Err(DraftError::EmptySide);
        }
        Ok(Draft::plain(Content::Match { sides, terms }))
    }

    /// A `score`.
    pub fn score(match_id: MatchId, slot: u64, value: Vec<u8>, replaces: Vec<RecordId>) -> Draft {
        Draft::plain(Content::Score {
            match_id,
            slot,
            value,
            replaces,
        })
    }

    /// A `result`. To sign someone else's outcome, pass the subject read out
    /// of their record ([`Record::subject`]), which re-encodes to the same
    /// bytes (R6).
    pub fn result(subject: Subject, player: PlayerId, supersedes: Vec<RecordId>) -> Draft {
        Draft::plain(Content::Result {
            subject,
            player,
            supersedes,
        })
    }

    /// A `ruling`.
    pub fn ruling(subject: Subject) -> Draft {
        Draft::plain(Content::Ruling { subject })
    }

    /// A `close` for a match.
    pub fn close_match(match_id: MatchId, official: Option<Tag>) -> Draft {
        Draft::plain(Content::CloseMatch { match_id, official })
    }

    /// A `grant` signature.
    pub fn grant(subject: GrantSubject, side: GrantSide, stamp: Stamp) -> Draft {
        Draft::stamped(Content::Grant { subject, side }, stamp)
    }

    /// A `same-person` request.
    pub fn same_person(first: PlayerId, second: PlayerId, stamp: Stamp) -> Draft {
        Draft::stamped(Content::SamePerson { first, second }, stamp)
    }

    /// A `release` request.
    pub fn release(player: PlayerId, stamp: Stamp) -> Draft {
        Draft::stamped(Content::Release { player }, stamp)
    }

    /// A `revoke` request.
    pub fn revoke(key: PublicKey, stamp: Stamp) -> Draft {
        Draft::stamped(Content::Revoke { key }, stamp)
    }

    /// A `suspend` request (staff).
    pub fn suspend(fields: StaffFields, stamp: Stamp) -> Draft {
        Draft::stamped(Content::Suspend(fields), stamp)
    }

    /// A `reinstate` request (staff).
    pub fn reinstate(fields: StaffFields, stamp: Stamp) -> Draft {
        Draft::stamped(Content::Reinstate(fields), stamp)
    }

    /// A `clear-name` request (staff).
    pub fn clear_name(fields: StaffFields, stamp: Stamp) -> Draft {
        Draft::stamped(Content::ClearName(fields), stamp)
    }

    fn plain(content: Content) -> Draft {
        Draft {
            content,
            stamp: None,
        }
    }

    fn stamped(content: Content, stamp: Stamp) -> Draft {
        Draft {
            content,
            stamp: Some(stamp),
        }
    }

    /// The kind.
    pub fn kind(&self) -> Kind {
        self.content
            .kind()
            .expect("drafts are built only by the typed constructors")
    }

    /// The body bytes to sign: the header followed by the draft's fields.
    pub fn body(
        &self,
        environment: Environment,
        signer: PublicKey,
        random: [u8; layout::RANDOM_LENGTH],
        clock: Option<ClockReading>,
    ) -> Result<Vec<u8>, DraftError> {
        let header = Header {
            format_version: layout::FORMAT_VERSION,
            kind: self.kind().number(),
            environment,
            signer,
            random,
            clock,
            stamp: self.stamp,
        };
        let body = encode_body(&header, &self.content);
        if body.len() > MAX_BODY_LENGTH {
            return Err(DraftError::TooLarge);
        }
        Ok(body)
    }
}

/// Why a record does not verify.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadSignature;

impl fmt::Display for BadSignature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the signature does not verify against the key in the body")
    }
}

impl std::error::Error for BadSignature {}

/// A record: a body that decodes strictly and a signature in the stored form.
///
/// Holding a `Record` does not mean its signature verifies. Call
/// [`Record::verify`] (or verify [`Record::signed_message`] outside the core).
#[derive(Clone)]
pub struct Record {
    body: Vec<u8>,
    signature: Signature,
    header: Header,
    content: Content,
}

impl PartialEq for Record {
    fn eq(&self, other: &Self) -> bool {
        self.body == other.body && self.signature == other.signature
    }
}

impl Eq for Record {}

impl fmt::Debug for Record {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Record")
            .field("header", &self.header)
            .field("content", &self.content)
            .field("signature", &self.signature)
            .finish()
    }
}

impl Record {
    /// A record from its body and its stored 64-byte signature. Fails unless
    /// the body is the one encoding of a valid body and the signature is in
    /// the stored form. Does not verify the signature.
    pub fn from_parts(body: &[u8], signature: &[u8]) -> Result<Record, RecordError> {
        let signature = Signature::from_stored(signature).map_err(RecordError::Signature)?;
        Record::assemble(body.to_vec(), signature)
    }

    /// A record from a body and a converted signature (see
    /// [`Signature::from_der`] and [`Signature::from_raw`]).
    pub fn assemble(body: Vec<u8>, signature: Signature) -> Result<Record, RecordError> {
        let (header, content) = decode_body(&body)?;
        Ok(Record {
            body,
            signature,
            header,
            content,
        })
    }

    /// Like [`Record::assemble`], then verifies. This is the self-check that
    /// `commit` runs before it stores anything (design section 4.5).
    pub fn assemble_verified(
        body: Vec<u8>,
        signature: Signature,
        crypto: &impl Crypto,
    ) -> Result<Record, AssembleError> {
        let record = Record::assemble(body, signature).map_err(AssembleError::Record)?;
        record
            .verify(crypto)
            .map_err(|_| AssembleError::BadSignature)?;
        Ok(record)
    }

    /// A standalone record: a CBOR array of the body and the signature, both
    /// byte strings.
    pub fn decode(bytes: &[u8]) -> Result<Record, RecordError> {
        let mut reader = cbor::Reader::new(bytes, None);
        if reader.array_head()? != 2 {
            return Err(RecordError::NotARecord);
        }
        let body = reader.bytes()?;
        let signature = reader.bytes()?;
        reader.finish()?;
        Record::from_parts(&body, &signature)
    }

    /// The standalone form.
    pub fn to_bytes(&self) -> Vec<u8> {
        cbor::encode(&Value::Array(vec![
            Value::Bytes(self.body.clone()),
            Value::Bytes(self.signature.as_bytes().to_vec()),
        ]))
    }

    /// The body bytes.
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    /// The bytes the signature is over: the body. ECDSA hashes them with
    /// SHA-256.
    pub fn signed_message(&self) -> &[u8] {
        &self.body
    }

    /// The signature.
    pub fn signature(&self) -> &Signature {
        &self.signature
    }

    /// The header.
    pub fn header(&self) -> &Header {
        &self.header
    }

    /// The fields after the header.
    pub fn content(&self) -> &Content {
        &self.content
    }

    /// The kind, if the design names its number.
    pub fn kind(&self) -> Option<Kind> {
        Kind::from_number(self.header.kind)
    }

    /// The subject of a `result` or `ruling`.
    pub fn subject(&self) -> Option<&Subject> {
        match &self.content {
            Content::Result { subject, .. } | Content::Ruling { subject } => Some(subject),
            _ => None,
        }
    }

    /// Check the signature against the key in the body (R1, R3).
    pub fn verify(&self, crypto: &impl Crypto) -> Result<(), BadSignature> {
        if crypto.verify_p256_sha256(
            self.header.signer.as_bytes(),
            &self.body,
            self.signature.as_bytes(),
        ) {
            Ok(())
        } else {
            Err(BadSignature)
        }
    }

    /// The record id: the hash of the body.
    pub fn id(&self, crypto: &impl Crypto) -> RecordId {
        ids::record_id(crypto, &self.body)
    }

    /// The id of the match this `match` record creates.
    pub fn match_id(&self, crypto: &impl Crypto) -> Option<MatchId> {
        matches!(self.content, Content::Match { .. }).then(|| self.id(crypto).as_match_id())
    }

    /// The id of the extra player this `player` record creates.
    pub fn extra_player_id(&self, crypto: &impl Crypto) -> Option<PlayerId> {
        matches!(self.content, Content::Player).then(|| self.id(crypto).as_extra_player_id())
    }

    /// The id of the outcome a `result` or `ruling` is for.
    pub fn outcome_id(&self, crypto: &impl Crypto) -> Option<OutcomeId> {
        self.subject().map(|subject| subject.outcome_id(crypto))
    }

    /// The signer's account id before any merge.
    pub fn signer_account_id(&self, crypto: &impl Crypto) -> AccountId {
        self.header.signer.account_id(crypto)
    }

    /// The signer's own player id.
    pub fn signer_own_player_id(&self, crypto: &impl Crypto) -> PlayerId {
        self.header.signer.own_player_id(crypto)
    }
}

/// Why [`Record::assemble_verified`] failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssembleError {
    /// The body or the signature is malformed.
    Record(RecordError),
    /// The signature does not verify.
    BadSignature,
}

impl fmt::Display for AssembleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AssembleError::Record(error) => error.fmt(f),
            AssembleError::BadSignature => BadSignature.fmt(f),
        }
    }
}

impl std::error::Error for AssembleError {}
