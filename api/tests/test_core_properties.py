"""Properties of the core's Python module (core/bindings/python) over generated inputs, beside
the golden vectors of test_core.py: the username's form, and that bytes of the wrong form raise
`ValueError` (a Rust panic would surface as pyo3's `PanicException`, which is not one)."""

import re
from collections.abc import Callable

import fortymm_core
import pytest
from hypothesis import given
from hypothesis import strategies as st

# core/src/layout.rs, module username.
SUFFIX_ALPHABET = "0123456789bcdfghjkmnpqrstvwxz"
MIN_SUFFIX_LENGTH = 4
MAX_SUFFIX_LENGTH = 16

player_ids = st.binary(min_size=32, max_size=32)
suffix_lengths = st.integers(MIN_SUFFIX_LENGTH, MAX_SUFFIX_LENGTH)


def wrong_length(length: int) -> st.SearchStrategy[bytes]:
    return st.binary(max_size=2 * length).filter(lambda b: len(b) != length)


def first_byte_not_in(allowed: set[int], length: int) -> st.SearchStrategy[bytes]:
    return st.builds(
        lambda first, rest: bytes([first]) + rest,
        st.integers(0, 255).filter(lambda b: b not in allowed),
        st.binary(min_size=length - 1, max_size=length - 1),
    )


@given(player_ids, suffix_lengths, suffix_lengths)
def test_a_longer_suffix_extends_a_shorter_one(player_id: bytes, m: int, n: int) -> None:
    shorter, longer = sorted((m, n))
    assert fortymm_core.username(player_id, longer).startswith(
        fortymm_core.username(player_id, shorter)
    )


@given(player_ids, suffix_lengths)
def test_a_username_is_adjective_animal_suffix(player_id: bytes, length: int) -> None:
    form = rf"[a-z]+-[a-z]+-[{SUFFIX_ALPHABET}]{{{length}}}"
    assert re.fullmatch(form, fortymm_core.username(player_id, length))


@given(player_ids, suffix_lengths)
def test_a_username_depends_on_its_inputs_alone(player_id: bytes, length: int) -> None:
    assert fortymm_core.username(player_id, length) == fortymm_core.username(player_id, length)


@given(wrong_length(32), suffix_lengths)
def test_refuses_a_player_id_of_any_other_length(player_id: bytes, length: int) -> None:
    with pytest.raises(ValueError):
        fortymm_core.username(player_id, length)


@given(wrong_length(65))
def test_refuses_an_exported_key_of_any_other_length(key: bytes) -> None:
    with pytest.raises(ValueError):
        fortymm_core.compress_public_key(key)


@given(first_byte_not_in({0x04}, 65))
def test_refuses_an_exported_key_not_marked_uncompressed(key: bytes) -> None:
    with pytest.raises(ValueError):
        fortymm_core.compress_public_key(key)


@given(st.binary(min_size=64, max_size=64))
def test_refuses_an_exported_key_off_the_curve(coordinates: bytes) -> None:
    # A random X and Y lie on P-256 with probability about 2^-256.
    with pytest.raises(ValueError):
        fortymm_core.compress_public_key(b"\x04" + coordinates)


ID_FUNCTIONS = [fortymm_core.account_id, fortymm_core.own_player_id]


@pytest.mark.parametrize("compute", ID_FUNCTIONS, ids=lambda f: f.__name__)
@given(key=wrong_length(33))
def test_refuses_a_public_key_of_any_other_length(
    compute: Callable[[bytes], bytes], key: bytes
) -> None:
    with pytest.raises(ValueError):
        compute(key)


@pytest.mark.parametrize("compute", ID_FUNCTIONS, ids=lambda f: f.__name__)
@given(key=first_byte_not_in({0x02, 0x03}, 33))
def test_refuses_a_public_key_not_marked_compressed(
    compute: Callable[[bytes], bytes], key: bytes
) -> None:
    with pytest.raises(ValueError):
        compute(key)
