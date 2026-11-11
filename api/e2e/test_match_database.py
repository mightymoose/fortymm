import httpx

# A match parcel for the development environment, which api-release is configured as
# (compose.dev.yaml). Made and signed the way the web client makes one; see
# tests/support/records.py, which holds the same parcel.
MATCH_ID = "e2622c7d5d9d71fadfe41602761bdaa795e91f1f3bceb500c91fdeacef236eb3"
PARCEL = (
    "061G7041GAKG00810C1060TR441FYZ4J44HZS6MBZRNNEHYX65HY2VNAZF2AF9E8149FJ80HFDEE7B84917WZ0"
    "4NDRYR5688GA0NG80H248H248H248H248H248H248H248H248H248H248H248H248H260NG81248H248H248H"
    "248H248H248H248H248H248H248H248H248H2484M20AR82JRKNRDWTC056BV11F4BZ55T7N6120S8SM96XWW"
    "8QGA2VNEYERERKYWEYNP26WD5KEJDBC4EWWS8YG3C9QHE8SWB2WYB2KRPCBXP586NN29DH0"
)


def test_the_shipped_api_applies_a_match_parcel_with_the_core(api: httpx.Client) -> None:
    # Wiring only: the production image loads the core's Python module, takes its
    # environment from the stack, and parses and verifies a real parcel. Every case of
    # the logic is proven in process, in api/tests/.
    response = api.post(
        "/v1/match-database/apply",
        json={"database": {}, "parcels": [PARCEL], "arrived_at": "2026-11-11T12:00:00Z"},
    )

    assert response.status_code == 200
    attributes = response.json()["data"]["attributes"]
    assert [m["match_id"] for m in attributes["database"]["matches"]] == [MATCH_ID]
    assert attributes["parcels"][0]["records"] == [
        {"record_id": MATCH_ID, "answer": "held", "reason": None}
    ]
