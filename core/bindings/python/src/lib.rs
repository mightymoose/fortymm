//! The core as a Python module (`import fortymm_core`), for the api.

use pyo3::prelude::*;

/// The `fortymm_core` module.
#[pymodule]
mod fortymm_core {
    use super::*;

    /// A greeting, to prove the core builds into the api.
    #[pyfunction]
    fn hello_world() -> &'static str {
        fmm::hello_world()
    }
}
