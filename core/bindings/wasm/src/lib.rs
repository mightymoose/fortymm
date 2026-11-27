//! The core for browsers (`import { hello_world } from 'fortymm-core-wasm'`).

use wasm_bindgen::prelude::*;

/// A greeting, to prove the core builds into the web client.
#[wasm_bindgen]
pub fn hello_world() -> String {
    fortymm_core::hello_world().to_owned()
}
