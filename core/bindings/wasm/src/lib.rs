//! The core for browsers (`import { username } from 'fortymm-core-wasm'`).
//!
//! Bytes cross as `Uint8Array`s. Bytes of the wrong form throw an `Error` saying why.

use fortymm_core::{PlayerId, PublicKey};
use wasm_bindgen::prelude::*;

/// A greeting, to prove the core builds into the web client.
#[wasm_bindgen]
pub fn hello_world() -> String {
    fortymm_core::hello_world().to_owned()
}

/// The 33-byte compressed form of a public key WebCrypto exported raw (65 bytes, uncompressed).
#[wasm_bindgen]
pub fn compress_public_key(uncompressed: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(PublicKey::from_sec1_uncompressed(uncompressed)?
        .as_bytes()
        .to_vec())
}

/// The account id of a 33-byte compressed public key.
#[wasm_bindgen]
pub fn account_id(public_key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(PublicKey::from_sec1_compressed(public_key)?
        .account_id()
        .as_bytes()
        .to_vec())
}

/// The own player id of a 33-byte compressed public key.
#[wasm_bindgen]
pub fn own_player_id(public_key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(PublicKey::from_sec1_compressed(public_key)?
        .own_player_id()
        .as_bytes()
        .to_vec())
}

/// The generated username of a 32-byte player id, with a suffix of `suffix_length` characters
/// (4 to 16).
#[wasm_bindgen]
pub fn username(player_id: &[u8], suffix_length: usize) -> Result<String, JsError> {
    let id: [u8; 32] = player_id
        .try_into()
        .map_err(|_| JsError::new("a player id is 32 bytes"))?;
    Ok(PlayerId::from_bytes(id).username(suffix_length)?)
}
