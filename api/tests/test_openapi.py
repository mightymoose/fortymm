from fortymm_api.openapi import SCHEMA_PATH, render_schema


def test_committed_schema_is_up_to_date() -> None:
    assert SCHEMA_PATH.read_text() == render_schema(), (
        "openapi.json is out of date; run `./bin/mise run api:openapi`"
    )
