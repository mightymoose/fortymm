# api's suite against the image it ships (api-release), run by api:e2e, the
# last step of api:validate. A bare `pytest` runs only tests/ (testpaths).
import os
from collections.abc import Iterator

import httpx
import pytest


@pytest.fixture
def api() -> Iterator[httpx.Client]:
    """A client for the api as it ships. BASE_URL is set by compose.dev.yaml."""
    base_url = os.environ.get("BASE_URL")
    if not base_url:
        pytest.fail("BASE_URL is not set. Run this suite with ./bin/mise run api:e2e")
    with httpx.Client(base_url=base_url, timeout=10) as client:
        yield client
