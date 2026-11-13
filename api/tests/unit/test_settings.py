import pytest
from pydantic import ValidationError

from api.settings import Settings

# How a Cloud Run service reaches Cloud SQL: no host in the address, the Unix
# socket's directory in the `host` query parameter, and the user in `user` (a URL
# can't have a user without a host).
CLOUD_SQL_SOCKET_URL = (
    "postgresql:///pr_9?host=/cloudsql/fortymm:northamerica-northeast2:fortymm-api-preview"
    "&user=api_preview"
)


def test_a_database_url_with_a_host_is_accepted() -> None:
    settings = Settings(database_url="postgresql://api:api@api-db:5432/api")

    assert str(settings.database_url) == "postgresql://api:api@api-db:5432/api"


def test_a_database_url_naming_a_unix_socket_directory_is_accepted_unchanged() -> None:
    settings = Settings(database_url=CLOUD_SQL_SOCKET_URL)

    assert str(settings.database_url) == CLOUD_SQL_SOCKET_URL


def test_a_database_url_with_neither_a_host_nor_a_socket_directory_is_refused() -> None:
    with pytest.raises(ValidationError, match="names no host"):
        Settings(database_url="postgresql:///api?user=api")
