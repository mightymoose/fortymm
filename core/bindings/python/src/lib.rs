//! The core as a Python module (`import fortymm_core`), for the api.
//!
//! Bytes cross as `bytes`. Bytes of the wrong form raise `ValueError` saying why.

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

/// The `fortymm_core` module.
#[pymodule]
mod fortymm_core {
    use super::*;

    fn invalid(error: impl ToString) -> PyErr {
        PyValueError::new_err(error.to_string())
    }

    /// A greeting, to prove the core builds into the api.
    #[pyfunction]
    fn hello_world() -> &'static str {
        fmm::hello_world()
    }

    /// The 33-byte compressed form of an uncompressed (65-byte) SEC1 public key.
    #[pyfunction]
    fn compress_public_key<'py>(
        py: Python<'py>,
        uncompressed: &[u8],
    ) -> PyResult<Bound<'py, PyBytes>> {
        let key = fmm::PublicKey::from_sec1_uncompressed(uncompressed).map_err(invalid)?;
        Ok(PyBytes::new(py, key.as_bytes()))
    }

    /// The account id of a 33-byte compressed public key.
    #[pyfunction]
    fn account_id<'py>(py: Python<'py>, public_key: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
        let key = fmm::PublicKey::from_sec1_compressed(public_key).map_err(invalid)?;
        Ok(PyBytes::new(py, key.account_id().as_bytes()))
    }

    /// The own player id of a 33-byte compressed public key.
    #[pyfunction]
    fn own_player_id<'py>(py: Python<'py>, public_key: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
        let key = fmm::PublicKey::from_sec1_compressed(public_key).map_err(invalid)?;
        Ok(PyBytes::new(py, key.own_player_id().as_bytes()))
    }

    /// The generated username of a 32-byte player id, with a suffix of `suffix_length`
    /// characters (4 to 16).
    #[pyfunction]
    fn username(player_id: &[u8], suffix_length: usize) -> PyResult<String> {
        let id: [u8; 32] = player_id
            .try_into()
            .map_err(|_| invalid("a player id is 32 bytes"))?;
        fmm::PlayerId::from_bytes(id)
            .username(suffix_length)
            .map_err(invalid)
    }
}
