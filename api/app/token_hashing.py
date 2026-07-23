"""Shared token-hashing helper.

Opaque bearer credentials (session cookies, magic-link / email-change / merge
tokens) are only ever stored as a sha256 digest of their raw bytes, never in
plaintext. This one-liner is the single place that digest is computed, imported
by the session/auth flows (``app/sessions.py``) so callers don't reach into
each other's internals for it.
"""

import hashlib


def hash_token(raw_token: str) -> bytes:
    return hashlib.sha256(raw_token.encode("utf-8")).digest()
