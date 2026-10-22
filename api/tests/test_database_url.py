import pytest

from fortymm_api.main import create_app


def test_refuses_to_start_on_cloud_run_without_a_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("K_SERVICE", "api")
    monkeypatch.setenv("WORKER_SECRET", "s3cret")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        create_app()
