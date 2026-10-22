from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from fortymm_api.main import create_app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as client:
        yield client
