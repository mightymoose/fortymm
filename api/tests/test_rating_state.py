"""The ``rating_state`` parse boundary (``app.ratings.state``).

The confidence card centres its interval on the parsed state's ``rating`` while
the hero renders the row's ``rating_value`` column — they agree only because
every write sets ``rating_value`` from ``state_rating_value(state)``. These tests
pin the boundary that turns a drift between those two copies into a loud failure
rather than a silent one-number-here / different-range-there.
"""

import pytest

from app.ratings.state import (
    Glicko2State,
    ManualState,
    RatingStateValueMismatchError,
    parse_rating_state,
)


def test_parse_rating_state_consistent_glicko2_value_parses_cleanly():
    """A blob whose ``rating`` matches the stored ``rating_value`` decodes to a
    typed ``Glicko2State`` with no raise."""
    state = parse_rating_state(
        "glicko2",
        {"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
        1500.0,
    )
    assert isinstance(state, Glicko2State)
    assert state.rating == 1500.0


def test_parse_rating_state_null_rating_value_skips_the_invariant():
    """The unrated carve-out: a player seeded into a league who has not
    completed a rated match has a parsed seed state but a NULL ``rating_value``.
    The invariant must NOT fire — passing ``None`` parses cleanly."""
    state = parse_rating_state(
        "glicko2",
        {"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
        None,
    )
    assert isinstance(state, Glicko2State)
    assert state.rating == 1500.0


def test_parse_rating_state_omitted_rating_value_skips_the_invariant():
    """``rating_value`` defaults to ``None`` — a caller that has no column value
    to check against (and manual/awaiting-import rows) parses without a raise."""
    state = parse_rating_state(
        "glicko2",
        {"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
    )
    assert isinstance(state, Glicko2State)


def test_parse_rating_state_mismatched_value_raises_naming_both_numbers():
    """A non-null ``rating_value`` that disagrees with the blob's ``rating`` is
    corruption: the boundary raises, and the exception names BOTH numbers so the
    inconsistent row is obvious."""
    with pytest.raises(RatingStateValueMismatchError) as excinfo:
        parse_rating_state(
            "glicko2",
            {"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
            1490.0,
        )
    err = excinfo.value
    assert err.rating_value == 1490.0
    assert err.state_rating == 1500.0
    message = str(err)
    assert "1490.0" in message
    assert "1500.0" in message


def test_parse_rating_state_mismatched_manual_value_also_raises():
    """The invariant holds for every strategy that stores a ``rating`` — a
    manual (imported) row whose column drifted from its blob raises too."""
    with pytest.raises(RatingStateValueMismatchError):
        parse_rating_state("manual", {"rating": 1750.0}, 1751.0)


def test_parse_rating_state_consistent_manual_value_parses_cleanly():
    """A consistent manual row decodes to a ``ManualState`` with no raise."""
    state = parse_rating_state("manual", {"rating": 1750.0}, 1750.0)
    assert isinstance(state, ManualState)
    assert state.rating == 1750.0


def test_parse_rating_state_none_blob_is_never_checked():
    """No blob, no state, no invariant — a manual-league member awaiting an
    import parses to ``None`` even if a stray ``rating_value`` is passed."""
    assert parse_rating_state("glicko2", None, 1500.0) is None
