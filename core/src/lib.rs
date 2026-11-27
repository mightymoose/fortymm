//! FortyMM shared core.

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
