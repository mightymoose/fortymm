//! The core as a Python module (`import fortymm_core`), for the server.
//!
//! Byte values are `bytes`. Malformed input raises `fortymm_core.Malformed`,
//! and damaged parcel text raises `fortymm_core.Damaged`. Both are
//! `ValueError`s.

use pyo3::create_exception;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

use fmm::{
    ClockReading, Draft, Environment, Parcel, PlayerId, PublicKey, Record, Signature, Software,
};

create_exception!(fortymm_core, Malformed, PyValueError);
create_exception!(fortymm_core, Damaged, PyValueError);

fn bytes<'py>(py: Python<'py>, data: &[u8]) -> Bound<'py, PyBytes> {
    PyBytes::new(py, data)
}

fn malformed(error: impl ToString) -> PyErr {
    Malformed::new_err(error.to_string())
}

/// A record: a body that decodes strictly and a stored signature.
#[pyclass(frozen, name = "Record", module = "fortymm_core")]
#[derive(Clone)]
struct PyRecord(Record);

#[pymethods]
impl PyRecord {
    /// Decode a standalone record (`[body, signature]`).
    #[staticmethod]
    fn decode(data: &[u8]) -> PyResult<Self> {
        Record::decode(data).map(PyRecord).map_err(malformed)
    }

    /// A record from its body and its stored 64-byte signature.
    #[staticmethod]
    fn from_parts(body: &[u8], signature: &[u8]) -> PyResult<Self> {
        Record::from_parts(body, signature)
            .map(PyRecord)
            .map_err(malformed)
    }

    fn to_bytes<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, &self.0.to_bytes())
    }

    #[getter]
    fn body<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.body())
    }

    #[getter]
    fn signature<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.signature().as_bytes())
    }

    #[getter]
    fn signer<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.header().signer.as_bytes())
    }

    #[getter]
    fn format_version(&self) -> u64 {
        self.0.header().format_version
    }

    #[getter]
    fn kind(&self) -> u64 {
        self.0.header().kind
    }

    /// The kind's name, or None for a number the design does not name.
    #[getter]
    fn kind_name(&self) -> Option<&'static str> {
        self.0.kind().map(|kind| kind.name())
    }

    /// Whether this library decoded the kind's fields.
    #[getter]
    fn interpreted(&self) -> bool {
        !matches!(self.0.content(), fmm::Content::Other(_))
    }

    #[getter]
    fn environment(&self) -> u64 {
        self.0.header().environment.0
    }

    // The getters below report what the bytes say, not that the record
    // counts: call verify() for that. A record this library did not interpret
    // (an unknown kind, or a format version it cannot read) gives None from
    // each; it still has its signer.

    /// A `match` record's two sides, each a list of 32-byte player ids; one
    /// may be empty, an anonymous side. None
    /// for every other record, including a `match` at a format version this
    /// library did not interpret.
    #[getter]
    fn sides<'py>(&self, py: Python<'py>) -> Option<Vec<Vec<Bound<'py, PyBytes>>>> {
        self.0.sides().map(|sides| {
            sides
                .iter()
                .map(|side| side.iter().map(|p| bytes(py, p.as_bytes())).collect())
                .collect()
        })
    }

    /// A `match` record's terms (opaque bytes). None for every other record.
    #[getter]
    fn terms<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0.terms().map(|terms| bytes(py, terms))
    }

    /// Whether a `match` record names a player more than once (on both
    /// sides, or twice on one). Such a match is read normally. None for every
    /// other record.
    #[getter]
    fn repeats_player(&self) -> Option<bool> {
        self.0.repeats_player()
    }

    /// The key that created the match or extra player: the signer of a
    /// `match` or `player` record. None for every other record.
    #[getter]
    fn creator<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0.creator().map(|key| bytes(py, key.as_bytes()))
    }

    /// The key a `hello` record introduces (its signer). None for every other
    /// record.
    #[getter]
    fn introduced_key<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0.introduced_key().map(|key| bytes(py, key.as_bytes()))
    }

    // What a `score` record says. None for every other record.

    /// The match a `score` record is about (`match_id()` is a `match`
    /// record's own id).
    #[getter]
    fn scored_match<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0.scored_match().map(|id| bytes(py, id.as_bytes()))
    }

    /// A `score` record's slot: n for game n. Slot 0 is accepted but means
    /// no game.
    #[getter]
    fn slot(&self) -> Option<u64> {
        self.0.slot()
    }

    /// A `score` record's value (opaque bytes).
    #[getter]
    fn value<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0.value().map(|value| bytes(py, value))
    }

    /// The ids of the `score` records a `score` record replaces.
    #[getter]
    fn replaces<'py>(&self, py: Python<'py>) -> Option<Vec<Bound<'py, PyBytes>>> {
        self.0
            .replaces()
            .map(|ids| ids.iter().map(|id| bytes(py, id.as_bytes())).collect())
    }

    fn id<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.id(&Software).as_bytes())
    }

    fn verify(&self) -> bool {
        self.0.verify(&Software).is_ok()
    }

    fn outcome_id<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0
            .outcome_id(&Software)
            .map(|id| bytes(py, id.as_bytes()))
    }

    fn match_id<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0
            .match_id(&Software)
            .map(|id| bytes(py, id.as_bytes()))
    }

    fn extra_player_id<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        self.0
            .extra_player_id(&Software)
            .map(|id| bytes(py, id.as_bytes()))
    }

    fn signer_account_id<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.signer_account_id(&Software).as_bytes())
    }

    fn signer_own_player_id<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.signer_own_player_id(&Software).as_bytes())
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.0 == other.0
    }

    fn __repr__(&self) -> String {
        format!(
            "Record(kind={}, id={})",
            self.0.kind().map_or("unknown", |kind| kind.name()),
            self.0
                .id(&Software)
                .as_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    }
}

/// An ordered list of records for one environment.
#[pyclass(frozen, name = "Parcel", module = "fortymm_core")]
struct PyParcel(Parcel);

#[pymethods]
impl PyParcel {
    #[new]
    fn new(environment: u64, records: Vec<PyRef<'_, PyRecord>>) -> PyResult<Self> {
        Parcel::new(
            Environment(environment),
            records.iter().map(|record| record.0.clone()).collect(),
        )
        .map(PyParcel)
        .map_err(malformed)
    }

    /// Parse text or a link. Raises Damaged.
    #[staticmethod]
    fn parse(text: &str) -> PyResult<Self> {
        Parcel::parse(text)
            .map(PyParcel)
            .map_err(|error| Damaged::new_err(error.to_string()))
    }

    #[staticmethod]
    fn from_binary(data: &[u8]) -> PyResult<Self> {
        Parcel::from_binary(data)
            .map(PyParcel)
            .map_err(|error| Damaged::new_err(error.to_string()))
    }

    #[getter]
    fn environment(&self) -> u64 {
        self.0.environment().0
    }

    #[getter]
    fn records(&self) -> Vec<PyRecord> {
        self.0.records().iter().cloned().map(PyRecord).collect()
    }

    fn to_binary<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, &self.0.to_binary())
    }

    fn text(&self) -> String {
        self.0.text()
    }

    fn link(&self, host: &str) -> String {
        self.0.link(host)
    }

    /// Split into complete parcels whose text is at most max_chars each.
    fn split(&self, max_chars: usize) -> PyResult<Vec<PyParcel>> {
        self.0
            .split(max_chars, &Software)
            .map(|parts| parts.into_iter().map(PyParcel).collect())
            .map_err(malformed)
    }
}

/// Convert a DER signature (iOS, Android) to the stored 64-byte form.
#[pyfunction]
fn signature_from_der<'py>(py: Python<'py>, der: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
    Signature::from_der(der)
        .map(|signature| bytes(py, signature.as_bytes()))
        .map_err(malformed)
}

/// Convert a raw r||s signature (WebCrypto) to the stored 64-byte form.
#[pyfunction]
fn signature_from_raw<'py>(py: Python<'py>, raw: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
    Signature::from_raw(raw)
        .map(|signature| bytes(py, signature.as_bytes()))
        .map_err(malformed)
}

fn key(public_key: &[u8]) -> PyResult<PublicKey> {
    PublicKey::from_sec1_compressed(public_key)
        .ok_or_else(|| malformed("not a compressed P-256 key"))
}

/// The account id of a 33-byte compressed public key.
#[pyfunction]
fn account_id<'py>(py: Python<'py>, public_key: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
    Ok(bytes(py, key(public_key)?.account_id(&Software).as_bytes()))
}

/// The own player id of a 33-byte compressed public key.
#[pyfunction]
fn own_player_id<'py>(py: Python<'py>, public_key: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
    Ok(bytes(
        py,
        key(public_key)?.own_player_id(&Software).as_bytes(),
    ))
}

/// The body of a `hello` introducing a 33-byte compressed public key, to
/// sign: for the environment, with an 8-byte random value and, optionally,
/// the clock in milliseconds since the Unix epoch. Assemble the signed record
/// with `Record.from_parts` and check it with `verify()`. Raises Malformed
/// for a key not in the stored form or a random value not 8 bytes long.
#[pyfunction]
#[pyo3(signature = (environment, public_key, random, clock=None))]
fn hello_body<'py>(
    py: Python<'py>,
    environment: u64,
    public_key: &[u8],
    random: &[u8],
    clock: Option<u64>,
) -> PyResult<Bound<'py, PyBytes>> {
    let signer = key(public_key)?;
    let random: [u8; 8] = random
        .try_into()
        .map_err(|_| malformed("the random value is 8 bytes"))?;
    Draft::hello()
        .body(
            Environment(environment),
            signer,
            random,
            clock.map(ClockReading::from_unix_millis),
        )
        .map(|body| bytes(py, &body))
        .map_err(malformed)
}

// ---- Making a `player`, a `match` and a `score` ----
//
// Each body is made as a `hello`'s is: sign it, assemble the record with
// `Record.from_parts` and check it with `verify()`. Each raises Malformed for
// a key not in the stored form, a random value not 8 bytes long, or an id
// not 32 bytes long.

/// The signer and the random value, refused as `hello_body` refuses them.
fn signer_and_random(public_key: &[u8], random: &[u8]) -> PyResult<(PublicKey, [u8; 8])> {
    let signer = key(public_key)?;
    let random = random
        .try_into()
        .map_err(|_| malformed("the random value is 8 bytes"))?;
    Ok((signer, random))
}

fn id_of(id: &Bound<'_, PyBytes>, what: &str) -> PyResult<[u8; 32]> {
    id.as_bytes()
        .try_into()
        .map_err(|_| malformed(format!("{what} is 32 bytes")))
}

fn body_of<'py>(
    py: Python<'py>,
    draft: &Draft,
    environment: u64,
    (signer, random): (PublicKey, [u8; 8]),
    clock: Option<u64>,
) -> PyResult<Bound<'py, PyBytes>> {
    draft
        .body(
            Environment(environment),
            signer,
            random,
            clock.map(ClockReading::from_unix_millis),
        )
        .map(|body| bytes(py, &body))
        .map_err(malformed)
}

/// The body of a `player`, to sign: a new extra player, created by the
/// signer. Its id is the record's (`extra_player_id()`), so each random value
/// is one player.
#[pyfunction]
#[pyo3(signature = (environment, public_key, random, clock=None))]
fn player_body<'py>(
    py: Python<'py>,
    environment: u64,
    public_key: &[u8],
    random: &[u8],
    clock: Option<u64>,
) -> PyResult<Bound<'py, PyBytes>> {
    let signer = signer_and_random(public_key, random)?;
    body_of(py, &Draft::player(), environment, signer, clock)
}

/// The body of a `match`, to sign: two sides, each a list of 32-byte player
/// ids, on terms the core carries. One side may be empty, an anonymous side,
/// never both; a match with an anonymous side can't be rated, so terms that
/// read as rated raise Malformed.
#[pyfunction]
#[pyo3(signature = (environment, public_key, random, sides, terms, clock=None))]
fn match_body<'py>(
    py: Python<'py>,
    environment: u64,
    public_key: &[u8],
    random: &[u8],
    sides: Vec<Vec<Bound<'py, PyBytes>>>,
    terms: &[u8],
    clock: Option<u64>,
) -> PyResult<Bound<'py, PyBytes>> {
    let signer = signer_and_random(public_key, random)?;
    let side = |side: &Vec<Bound<'py, PyBytes>>| -> PyResult<Vec<PlayerId>> {
        side.iter()
            .map(|id| Ok(PlayerId::from_bytes(id_of(id, "a player id")?)))
            .collect()
    };
    let [first, second] = sides.as_slice() else {
        return Err(malformed("a match has two sides"));
    };
    let draft = Draft::match_([side(first)?, side(second)?], terms.to_vec()).map_err(malformed)?;
    body_of(py, &draft, environment, signer, clock)
}

/// The body of a `score`, to sign, about the match with the 32-byte id
/// `match_id`. The slot is n for game n (0 is accepted but means no game); the value
/// is bytes the core carries and does not read; `replaces` lists the ids of
/// the `score` records this one replaces.
#[pyfunction]
#[pyo3(signature = (environment, public_key, random, match_id, slot, value, replaces, clock=None))]
#[allow(clippy::too_many_arguments)]
fn score_body<'py>(
    py: Python<'py>,
    environment: u64,
    public_key: &[u8],
    random: &[u8],
    match_id: &Bound<'py, PyBytes>,
    slot: u64,
    value: &[u8],
    replaces: Vec<Bound<'py, PyBytes>>,
    clock: Option<u64>,
) -> PyResult<Bound<'py, PyBytes>> {
    let signer = signer_and_random(public_key, random)?;
    let match_id = fmm::MatchId::from_bytes(id_of(match_id, "a match id")?);
    let replaces = replaces
        .iter()
        .map(|id| Ok(fmm::RecordId::from_bytes(id_of(id, "a record id")?)))
        .collect::<PyResult<Vec<_>>>()?;
    let draft = Draft::score(match_id, slot, value.to_vec(), replaces);
    body_of(py, &draft, environment, signer, clock)
}

/// The parcel checksum of some bytes.
#[pyfunction]
fn checksum(data: &[u8]) -> u32 {
    fmm::parcel::checksum(data)
}

/// The generated username of a 32-byte player id, with a suffix of
/// suffix_length characters (4 to 16). Raises Malformed otherwise.
#[pyfunction]
fn username(player_id: &[u8], suffix_length: i64) -> PyResult<String> {
    let length = usize::try_from(suffix_length).map_err(|_| malformed(fmm::BadSuffixLength))?;
    let player: [u8; 32] = player_id
        .try_into()
        .map_err(|_| malformed("a player id is 32 bytes"))?;
    PlayerId::from_bytes(player)
        .username(length)
        .map_err(malformed)
}

// ---- The product layouts (FORMAT.md section 15) ----------------------------
// The terms of a match and the value of a score: the bytes a record carries
// in its terms and value fields.

/// The terms of a match, as read from its bytes.
#[pyclass(frozen, eq, name = "Terms", module = "fortymm_core")]
#[derive(Clone, PartialEq)]
struct PyTerms {
    /// Best of how many games.
    #[pyo3(get)]
    best_of: u32,
    /// Whether the match is rated.
    #[pyo3(get)]
    rated: bool,
}

#[pymethods]
impl PyTerms {
    fn __repr__(&self) -> String {
        let rated = if self.rated { "True" } else { "False" };
        format!("Terms(best_of={}, rated={rated})", self.best_of)
    }
}

/// The value of a score, as read from its bytes.
#[pyclass(frozen, eq, name = "ScoreValue", module = "fortymm_core")]
#[derive(Clone, PartialEq)]
struct PyScoreValue {
    /// The two sides' points, first side first. None for a cleared game.
    #[pyo3(get)]
    score: Option<(u32, u32)>,
}

#[pymethods]
impl PyScoreValue {
    fn __repr__(&self) -> String {
        match self.score {
            Some((first, second)) => format!("ScoreValue(score=({first}, {second}))"),
            None => "ScoreValue(score=None)".to_string(),
        }
    }
}

/// The bytes of the terms of a match that is best of best_of games (an odd
/// number, 1 or more), rated or not. Raises Malformed for any other best of.
#[pyfunction]
fn terms_bytes<'py>(py: Python<'py>, best_of: i64, rated: bool) -> PyResult<Bound<'py, PyBytes>> {
    let best_of = u32::try_from(best_of).map_err(|_| malformed(fmm::BadBestOf))?;
    fmm::Terms::new(best_of, rated)
        .map(|terms| bytes(py, &terms.to_bytes()))
        .map_err(malformed)
}

/// Read terms. None for bytes of another layout version, and for damaged
/// bytes.
#[pyfunction]
fn read_terms(data: &[u8]) -> Option<PyTerms> {
    fmm::Terms::read(data).map(|terms| PyTerms {
        best_of: terms.best_of(),
        rated: terms.rated(),
    })
}

/// The bytes of a score value: the two sides' points in the game, first side
/// first, or None for a cleared game. Raises Malformed for points that are
/// not whole numbers from 0 to 4294967295.
#[pyfunction]
fn score_value<'py>(py: Python<'py>, score: Option<(i64, i64)>) -> PyResult<Bound<'py, PyBytes>> {
    let points =
        |side: i64| u32::try_from(side).map_err(|_| malformed("points are 0 to 4294967295"));
    let value = match score {
        Some((first, second)) => fmm::ScoreValue::Points([points(first)?, points(second)?]),
        None => fmm::ScoreValue::Cleared,
    };
    Ok(bytes(py, &value.to_bytes()))
}

/// Read a score value. None for bytes of another layout version, and for
/// damaged bytes.
#[pyfunction]
fn read_score_value(data: &[u8]) -> Option<PyScoreValue> {
    fmm::ScoreValue::read(data).map(|value| PyScoreValue {
        score: match value {
            fmm::ScoreValue::Points([first, second]) => Some((first, second)),
            fmm::ScoreValue::Cleared => None,
        },
    })
}

// A match's state, derived from its records (FORMAT.md section 16).

/// What a match's records say, as a device shows it.
#[pyclass(frozen, name = "MatchState", module = "fortymm_core")]
struct PyMatchState(fmm::MatchState);

#[pymethods]
impl PyMatchState {
    /// The match: the record id of its `match` record.
    #[getter]
    fn match_id<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.match_id.as_bytes())
    }

    /// The 33-byte key that signed the `match` record.
    #[getter]
    fn creator<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        bytes(py, self.0.creator.as_bytes())
    }

    /// The two sides, each a list of player ids.
    #[getter]
    fn sides<'py>(&self, py: Python<'py>) -> Vec<Vec<Bound<'py, PyBytes>>> {
        self.0
            .sides
            .iter()
            .map(|side| side.iter().map(|p| bytes(py, p.as_bytes())).collect())
            .collect()
    }

    /// The terms, or None for terms of a layout this build does not read.
    #[getter]
    fn terms(&self) -> Option<PyTerms> {
        self.0.terms.map(|terms| PyTerms {
            best_of: terms.best_of(),
            rated: terms.rated(),
        })
    }

    /// games[0] is game 1: its final score, first side first, or None for no
    /// score. Never ends with None.
    #[getter]
    fn games(&self) -> Vec<Option<(u32, u32)>> {
        self.0
            .games
            .iter()
            .map(|game| game.map(|[first, second]| (first, second)))
            .collect()
    }

    /// Per game, current[0] for game 1, the ids of the `score` records that
    /// no `score` record of that game replaces, lowest first.
    #[getter]
    fn current<'py>(&self, py: Python<'py>) -> Vec<Vec<Bound<'py, PyBytes>>> {
        self.0
            .current
            .iter()
            .map(|ids| ids.iter().map(|id| bytes(py, id.as_bytes())).collect())
            .collect()
    }
}

/// The state of the match a set of records is about: any order, repeats
/// allowed. `score` records of other matches, and records of other kinds,
/// are ignored. None when the set holds no `match` record, or a `match`
/// record of another match too: pass only this match's records.
#[pyfunction]
fn match_state(records: Vec<PyRef<'_, PyRecord>>) -> Option<PyMatchState> {
    let records: Vec<Record> = records.iter().map(|r| r.0.clone()).collect();
    fmm::match_state(&records, &Software).map(PyMatchState)
}

#[pymodule]
fn fortymm_core(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PyRecord>()?;
    module.add_class::<PyParcel>()?;
    module.add("Malformed", module.py().get_type::<Malformed>())?;
    module.add("Damaged", module.py().get_type::<Damaged>())?;
    module.add_function(wrap_pyfunction!(signature_from_der, module)?)?;
    module.add_function(wrap_pyfunction!(signature_from_raw, module)?)?;
    module.add_function(wrap_pyfunction!(account_id, module)?)?;
    module.add_function(wrap_pyfunction!(own_player_id, module)?)?;
    module.add_function(wrap_pyfunction!(checksum, module)?)?;
    module.add_function(wrap_pyfunction!(hello_body, module)?)?;
    module.add_function(wrap_pyfunction!(player_body, module)?)?;
    module.add_function(wrap_pyfunction!(match_body, module)?)?;
    module.add_function(wrap_pyfunction!(score_body, module)?)?;
    module.add_function(wrap_pyfunction!(username, module)?)?;
    module.add("FORMAT_VERSION", fmm::layout::FORMAT_VERSION)?;
    // The product layouts.
    module.add_class::<PyTerms>()?;
    module.add_class::<PyScoreValue>()?;
    module.add_function(wrap_pyfunction!(terms_bytes, module)?)?;
    module.add_function(wrap_pyfunction!(read_terms, module)?)?;
    module.add_function(wrap_pyfunction!(score_value, module)?)?;
    module.add_function(wrap_pyfunction!(read_score_value, module)?)?;
    // A match's state.
    module.add_class::<PyMatchState>()?;
    module.add_function(wrap_pyfunction!(match_state, module)?)?;
    Ok(())
}
