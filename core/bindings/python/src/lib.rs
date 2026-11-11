//! The core as a Python module (`import fortymm_core`), for the server.
//!
//! Byte values are `bytes`. Malformed input raises `fortymm_core.Malformed`,
//! and damaged parcel text raises `fortymm_core.Damaged`. Both are
//! `ValueError`s.

use pyo3::create_exception;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

use fmm::{Environment, Parcel, PublicKey, Record, Signature, Software};

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

    /// A `match` record's two sides, each a list of 32-byte player ids. None
    /// for every other record, including a `match` at a format version this
    /// library did not interpret.
    #[getter]
    fn sides<'py>(&self, py: Python<'py>) -> Option<Vec<Vec<Bound<'py, PyBytes>>>> {
        match self.0.content() {
            fmm::Content::Match { sides, .. } => Some(
                sides
                    .iter()
                    .map(|side| side.iter().map(|p| bytes(py, p.as_bytes())).collect())
                    .collect(),
            ),
            _ => None,
        }
    }

    /// A `match` record's terms (opaque bytes). None for every other record.
    #[getter]
    fn terms<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyBytes>> {
        match self.0.content() {
            fmm::Content::Match { terms, .. } => Some(bytes(py, terms)),
            _ => None,
        }
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

/// The parcel checksum of some bytes.
#[pyfunction]
fn checksum(data: &[u8]) -> u32 {
    fmm::parcel::checksum(data)
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
    module.add("FORMAT_VERSION", fmm::layout::FORMAT_VERSION)?;
    module.add("PRODUCTION", fmm::layout::environment::PRODUCTION)?;
    module.add("UAT", fmm::layout::environment::UAT)?;
    module.add("DEVELOPMENT", fmm::layout::environment::DEVELOPMENT)?;
    Ok(())
}
