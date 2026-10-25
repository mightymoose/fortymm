import pytest

from fortymm_api.main import create_app

AUTH0_SETTINGS = {
    "AUTH0_DOMAIN": "fortymm.us.auth0.com",
    "AUTH0_CLIENT_ID": "client-id",
    "AUTH0_CLIENT_SECRET": "client-secret",
}


@pytest.fixture
def cloud_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("K_SERVICE", "api")
    monkeypatch.setenv("WORKER_SECRET", "s3cret")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://api@/fortymm?host=/cloudsql/fortymm:us-central1:fortymm",
    )
    for name, value in AUTH0_SETTINGS.items():
        monkeypatch.setenv(name, value)


@pytest.mark.usefixtures("cloud_run")
@pytest.mark.parametrize("name", AUTH0_SETTINGS)
def test_refuses_to_start_on_cloud_run_without_an_auth0_setting(
    monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    monkeypatch.delenv(name)

    with pytest.raises(RuntimeError, match=name):
        create_app()


@pytest.mark.usefixtures("cloud_run")
def test_signs_in_through_auth0_on_cloud_run() -> None:
    app = create_app()

    provider = app.state.identity_provider
    assert provider.base_url == "https://fortymm.us.auth0.com"
    assert provider.client_id == "client-id"
    assert provider.client_secret == "client-secret"
