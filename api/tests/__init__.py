"""Test-suite package.

Deliberately empty of helpers — the one thing it does is pin the process
environment the whole suite runs under, and it does it *here* because this
module is imported before ``tests.conftest`` and before any ``tests.test_*``
module, i.e. before anything can import ``app`` or construct ``Settings``.

Why the deadline is so early: ``app.mcp_server`` builds its ``FastMCP`` at
**module import time**, and that calls ``get_settings()``. So anything reached
*after* ``conftest.py`` does ``from app.main import app`` is already too late —
including a ``pytest_configure`` hook, which runs later still.

A first-line assignment in ``conftest.py`` would in fact work today, and this
package is chosen over it not because that is impossible but because it cannot
*become* wrong: ``tests/`` is a package, so this module is guaranteed to run
before ``tests.conftest`` whatever order conftest's own imports end up in, and
before any sibling conftest a subdirectory might grow later. The guarantee is
structural rather than positional.
"""

import os

# Ask for the deterministic, network-free FakeGeocoder BY NAME. ``GEOCODER``
# defaults to ``google`` and a keyless ``google`` refuses to construct (see
# ``app.config.Settings._require_google_key``), so without this line a bare
# ``pytest`` on a laptop with no ambient environment would die at the first
# ``get_settings()``. CI sets the same value at the workflow level; this makes
# the local run need no ambient environment at all.
#
# Assigned rather than ``setdefault``-ed deliberately: the suite asserts exact
# ``FakeGeocoder`` coordinates and must never reach the network or spend Google
# quota, so an operator's stray ``GEOCODER=google`` must not change what runs.
# Tests that need to observe the real default (``tests/test_geocoder.py``)
# remove it for their own duration with ``monkeypatch.delenv``.
os.environ["GEOCODER"] = "fake"
