import pytest

from fortymm_api.database import create_database_engine
from fortymm_api.main import create_app


def test_refuses_to_start_on_cloud_run_without_a_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("K_SERVICE", "api")
    monkeypatch.setenv("WORKER_SECRET", "s3cret")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        create_app()


def test_connects_to_cloud_runs_unix_socket_with_libpqs_password() -> None:
    # The form api/deploy/cloud-run-deploy sets. libpq reads PGPASSWORD.
    engine = create_database_engine(
        "postgresql://api@/fortymm?host=/cloudsql/fortymm:us-central1:fortymm"
    )

    _, params = engine.dialect.create_connect_args(engine.url)

    assert engine.url.drivername == "postgresql+psycopg"
    assert params["host"] == "/cloudsql/fortymm:us-central1:fortymm"
    assert params["dbname"] == "fortymm"
    assert params["user"] == "api"
    assert "password" not in params
