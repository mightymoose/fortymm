"""The core's Python module (core/bindings/python), checked against the core's golden vectors
(core/vectors/vectors.json, baked into the image by api/Dockerfile): the same file the Rust and
wasm builds check, so all three compute the same ids and usernames."""

import json
from pathlib import Path
from typing import Any

import fortymm_core
import pytest

VECTORS: dict[str, Any] = json.loads(Path("/opt/fortymm-core/vectors.json").read_text())
KEYS = VECTORS["keys"]
USERNAMES = VECTORS["usernames"]


def named(entries: list[dict[str, Any]]) -> list[str]:
    return [entry["name"] for entry in entries]


def test_the_core_greets_the_world() -> None:
    assert fortymm_core.hello_world() == "Hello World"


@pytest.mark.parametrize("key", KEYS, ids=named(KEYS))
def test_compresses_an_exported_public_key(key: dict[str, str]) -> None:
    compressed = fortymm_core.compress_public_key(bytes.fromhex(key["uncompressed_public_key"]))
    assert compressed.hex() == key["public_key"]


@pytest.mark.parametrize("key", KEYS, ids=named(KEYS))
def test_computes_a_key_s_account_id(key: dict[str, str]) -> None:
    account = fortymm_core.account_id(bytes.fromhex(key["public_key"]))
    assert account.hex() == key["account_id"]


@pytest.mark.parametrize("key", KEYS, ids=named(KEYS))
def test_computes_a_key_s_own_player_id(key: dict[str, str]) -> None:
    player = fortymm_core.own_player_id(bytes.fromhex(key["public_key"]))
    assert player.hex() == key["own_player_id"]


@pytest.mark.parametrize(
    "key",
    VECTORS["invalid_uncompressed_public_keys"],
    ids=named(VECTORS["invalid_uncompressed_public_keys"]),
)
def test_refuses_a_malformed_exported_public_key(key: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        fortymm_core.compress_public_key(bytes.fromhex(key["public_key"]))


@pytest.mark.parametrize(
    "entry",
    USERNAMES,
    ids=[f"{e['player_id'][:8]}-{e['suffix_length']}" for e in USERNAMES],
)
def test_generates_a_player_s_username(entry: dict[str, Any]) -> None:
    name = fortymm_core.username(bytes.fromhex(entry["player_id"]), entry["suffix_length"])
    assert name == entry["username"]


@pytest.mark.parametrize("length", VECTORS["invalid_username_suffix_lengths"])
def test_refuses_a_suffix_length_out_of_range(length: int) -> None:
    with pytest.raises(ValueError):
        fortymm_core.username(bytes(32), length)


def test_refuses_a_player_id_that_is_not_32_bytes() -> None:
    with pytest.raises(ValueError):
        fortymm_core.username(bytes(31), 4)
