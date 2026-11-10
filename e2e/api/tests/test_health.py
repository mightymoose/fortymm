import httpx


def test_the_shipped_api_reaches_its_database(api: httpx.Client) -> None:
    # Wiring only: the production image starts, takes its database settings from
    # the stack, and reaches PostgreSQL over the network. Failure cases are
    # proven in process, in api/tests/.
    response = api.get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {
        "data": {"type": "health", "id": "api", "attributes": {"database": "ok"}}
    }
