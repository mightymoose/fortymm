"""The FortyMM core, built from core/bindings/python.

Bytes of the wrong form raise ValueError.
"""

def hello_world() -> str:
    """A greeting, to prove the core builds into the api."""

def compress_public_key(uncompressed: bytes) -> bytes:
    """The 33-byte compressed form of an uncompressed (65-byte) SEC1 public key."""

def account_id(public_key: bytes) -> bytes:
    """The account id of a 33-byte compressed public key."""

def own_player_id(public_key: bytes) -> bytes:
    """The own player id of a 33-byte compressed public key."""

def username(player_id: bytes, suffix_length: int) -> str:
    """The generated username of a 32-byte player id, with a 4- to 16-character suffix."""
