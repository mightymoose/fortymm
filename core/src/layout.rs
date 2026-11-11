//! Every number in the byte format, in one place.
//!
//! The design (DESIGN-primitives.md) describes the format in prose and assigns
//! none of these. Each was chosen by this implementation and is listed in
//! FORMAT.md. Nothing is frozen before the first public release (design
//! section 18), so changing one means editing it here, regenerating the golden
//! vectors and updating FORMAT.md.

/// The value of the format version field.
pub const FORMAT_VERSION: u64 = 1;

/// The size of a record's random value.
pub const RANDOM_LENGTH: usize = 8;

/// The size of a stamp.
pub const STAMP_LENGTH: usize = 8;

/// Map keys of the fields every body has. Keys below
/// [`FIRST_KIND_KEY`] belong to the header in every kind.
pub mod header {
    /// The format version.
    pub const FORMAT_VERSION: u64 = 0;
    /// The kind number.
    pub const KIND: u64 = 1;
    /// The environment number.
    pub const ENVIRONMENT: u64 = 2;
    /// The signer's compressed public key, 33 bytes.
    pub const SIGNER: u64 = 3;
    /// The random value, 8 bytes.
    pub const RANDOM: u64 = 4;
    /// Optional: the device's clock, in milliseconds since the Unix epoch.
    /// Display only.
    pub const CLOCK: u64 = 5;
    /// The stamp, 8 bytes. Present exactly in the kinds that go stale: a
    /// `grant` and every identity request.
    pub const STAMP: u64 = 6;
}

/// The first key a kind may use for its own fields.
pub const FIRST_KIND_KEY: u64 = 8;

/// Kind numbers.
pub mod kind {
    #![allow(missing_docs)]
    pub const HELLO: u64 = 1;
    pub const PLAYER: u64 = 2;
    pub const MATCH: u64 = 3;
    pub const SCORE: u64 = 4;
    pub const RESULT: u64 = 5;
    pub const RULING: u64 = 6;
    /// Closing a match (design section 4). The design calls this `close`.
    pub const CLOSE_MATCH: u64 = 7;
    pub const GRANT: u64 = 8;
    // Identity requests (design section 8.3).
    pub const ATTACH_EMAIL: u64 = 16;
    pub const JOIN: u64 = 17;
    pub const SAME_PERSON: u64 = 18;
    pub const NAME: u64 = 19;
    pub const RELEASE: u64 = 20;
    pub const REVOKE: u64 = 21;
    pub const CHANGE_EMAIL: u64 = 22;
    /// Closing an account (design section 8.3). The design calls this
    /// `close` too.
    pub const CLOSE_ACCOUNT: u64 = 23;
    pub const SUSPEND: u64 = 24;
    pub const REINSTATE: u64 = 25;
    pub const CLEAR_NAME: u64 = 26;
}

/// Environment numbers.
pub mod environment {
    #![allow(missing_docs)]
    pub const PRODUCTION: u64 = 1;
    pub const UAT: u64 = 2;
    pub const DEVELOPMENT: u64 = 3;
}

/// Map keys of each kind's own fields.
pub mod field {
    #![allow(missing_docs)]
    pub mod match_ {
        pub const SIDES: u64 = 8;
        pub const TERMS: u64 = 9;
    }
    pub mod score {
        pub const MATCH: u64 = 8;
        pub const SLOT: u64 = 9;
        pub const VALUE: u64 = 10;
        pub const REPLACES: u64 = 11;
    }
    pub mod result {
        pub const SUBJECT: u64 = 8;
        pub const PLAYER: u64 = 9;
        pub const SUPERSEDES: u64 = 10;
    }
    pub mod ruling {
        pub const SUBJECT: u64 = 8;
    }
    pub mod close_match {
        pub const MATCH: u64 = 8;
        pub const OFFICIAL: u64 = 9;
    }
    pub mod grant {
        pub const SUBJECT: u64 = 8;
        pub const SIDE: u64 = 9;
    }
    pub mod same_person {
        pub const FIRST: u64 = 8;
        pub const SECOND: u64 = 9;
    }
    pub mod release {
        pub const PLAYER: u64 = 8;
    }
    pub mod revoke {
        pub const KEY: u64 = 8;
    }
    /// `suspend` and `reinstate`.
    pub mod staff {
        pub const ACCOUNT: u64 = 8;
        pub const STAFF: u64 = 9;
        pub const REASON: u64 = 10;
    }
}

/// Values of a grant's "side" field.
pub mod grant_side {
    #![allow(missing_docs)]
    pub const GIVING: u64 = 1;
    pub const RECEIVING: u64 = 2;
}

/// Map keys inside a grant's subject.
pub mod grant_subject {
    #![allow(missing_docs)]
    pub const PLAYER: u64 = 0;
    pub const RECEIVER: u64 = 1;
    pub const LEAVER: u64 = 2;
    pub const SAME_AS: u64 = 3;
    pub const RANDOM: u64 = 4;
}

/// The parcel container.
pub mod parcel {
    /// The first byte of the binary form.
    pub const CONTAINER_VERSION: u8 = 1;
    /// A byte string is stored once when it is at least this long and
    /// appears at least twice.
    pub const SHARED_MIN_LENGTH: usize = 8;
    /// The generator of the checksum, x^32 + ... + 1 without its top term
    /// (the Castagnoli polynomial), used most significant bit first.
    pub const CHECKSUM_POLYNOMIAL: u32 = 0x1edc_6f41;
    /// The checksum register starts at this value, and the result is
    /// inverted.
    pub const CHECKSUM_INITIAL: u32 = 0xffff_ffff;
    /// The 32 characters of the text form, in value order (Crockford's
    /// set: digits, then capitals without I, L, O and U).
    pub const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    /// What a link starts with, before the host.
    pub const LINK_SCHEME: &str = "HTTPS://";
    /// What separates the host from the text.
    pub const LINK_PATH: &str = "/P/";
}
