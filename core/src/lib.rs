//! FortyMM shared core (design section 14): pure functions, the same on every platform. No input
//! or output, no keys, no clock and no random generator.
//!
//! So far it holds a key's computed ids ([`ids`]) and the generated username of a player
//! ([`username`]), which is all a device needs to show who it is with no server (design sections
//! 4, "Derived ids", and 8.4). Every number and list in the format is in [`layout`] and is
//! described in FORMAT.md.

mod hex;
pub mod ids;
pub mod layout;
pub mod username;

pub use ids::{AccountId, BadPublicKey, PlayerId, PublicKey};
pub use username::BadSuffixLength;

/// A greeting, to prove the core builds into every host.
pub fn hello_world() -> &'static str {
    "Hello World"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_world_greets_the_world() {
        assert_eq!(hello_world(), "Hello World");
    }
}
