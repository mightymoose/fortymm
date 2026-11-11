"""Every case of MatchDatabase: applying parcels of match records to a database passed in.

No database server is involved: the "database" is a value. Records come from
tests/support/records.py, made and signed the way the web client makes them.
"""

from datetime import UTC, datetime

import fortymm_core

from api.services.match_database import (
    PARCEL_TEXT_LIMIT,
    Applied,
    Database,
    InvalidDatabase,
    Match,
    MatchDatabase,
    ParcelOutcome,
    RecordAnswer,
    StoredRecord,
    matches_of,
)
from tests.support.records import FIRST_MATCH, HELLO_UAT, SECOND_MATCH, UAT_MATCH, Made

DEVELOPMENT = MatchDatabase(fortymm_core.DEVELOPMENT)
NOON = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)
LATER = datetime(2026, 11, 11, 13, 0, tzinfo=UTC)


def applied(result: Applied | InvalidDatabase) -> Applied:
    assert isinstance(result, Applied), result
    return result


def held(made: Made) -> ParcelOutcome:
    return ParcelOutcome("applied", None, (RecordAnswer(bytes.fromhex(made.id), "held"),))


def match_of(made: Made) -> Match:
    first, second = made.sides
    return Match(
        bytes.fromhex(made.id),
        (tuple(map(bytes.fromhex, first)), tuple(map(bytes.fromhex, second))),
        bytes.fromhex(made.terms),
        bytes.fromhex(made.signer),
    )


def parcel_of(environment: int, *records: fortymm_core.Record) -> str:
    return fortymm_core.Parcel(environment, list(records)).text()


def record(made: Made) -> fortymm_core.Record:
    return fortymm_core.Record.decode(bytes.fromhex(made.record))


def test_a_match_parcel_on_the_empty_database_stores_its_record_and_gives_its_match() -> None:
    result = applied(DEVELOPMENT.apply(Database(), [FIRST_MATCH.text], NOON))

    assert result.database == Database(
        records=(StoredRecord(1, NOON, "held", bytes.fromhex(FIRST_MATCH.record)),),
        matches=(match_of(FIRST_MATCH),),
    )
    assert result.parcels == (held(FIRST_MATCH),)


def test_the_same_parcel_again_changes_nothing_and_gets_the_same_answer() -> None:
    first = applied(DEVELOPMENT.apply(Database(), [FIRST_MATCH.text], NOON))

    again = applied(DEVELOPMENT.apply(first.database, [FIRST_MATCH.text], LATER))

    assert again.database == first.database
    assert again.parcels == first.parcels


def test_the_same_input_gives_the_same_output() -> None:
    database = applied(DEVELOPMENT.apply(Database(), [FIRST_MATCH.text], NOON)).database

    results = [DEVELOPMENT.apply(database, [SECOND_MATCH.text], LATER) for _ in range(2)]

    assert results[0] == results[1]


def test_two_parcels_in_either_order_give_the_same_matches() -> None:
    one = applied(DEVELOPMENT.apply(Database(), [FIRST_MATCH.text, SECOND_MATCH.text], NOON))
    other = applied(DEVELOPMENT.apply(Database(), [SECOND_MATCH.text, FIRST_MATCH.text], NOON))

    assert one.database.matches == other.database.matches
    assert {m.match_id for m in one.database.matches} == {
        bytes.fromhex(FIRST_MATCH.id),
        bytes.fromhex(SECOND_MATCH.id),
    }


def test_two_parcels_in_one_submit_equal_two_submits_at_the_same_time() -> None:
    together = applied(DEVELOPMENT.apply(Database(), [FIRST_MATCH.text, SECOND_MATCH.text], NOON))
    first = applied(DEVELOPMENT.apply(Database(), [FIRST_MATCH.text], NOON))
    then = applied(DEVELOPMENT.apply(first.database, [SECOND_MATCH.text], NOON))

    assert together.database == then.database
    assert [r.arrival for r in together.database.records] == [1, 2]


def test_a_record_whose_signature_does_not_verify_is_malformed_and_not_stored() -> None:
    # The first match's body with the second match's signature.
    forged = fortymm_core.Record.from_parts(
        record(FIRST_MATCH).body, record(SECOND_MATCH).signature
    )
    text = parcel_of(fortymm_core.DEVELOPMENT, forged, record(SECOND_MATCH))

    result = applied(DEVELOPMENT.apply(Database(), [text], NOON))

    assert result.parcels == (
        ParcelOutcome(
            "applied",
            None,
            (
                RecordAnswer(bytes.fromhex(FIRST_MATCH.id), "malformed", "bad_signature"),
                RecordAnswer(bytes.fromhex(SECOND_MATCH.id), "held"),
            ),
        ),
    )
    assert result.database.matches == (match_of(SECOND_MATCH),)


def test_a_parcel_for_another_environment_is_refused_and_the_next_is_applied() -> None:
    result = applied(DEVELOPMENT.apply(Database(), [UAT_MATCH.text, FIRST_MATCH.text], NOON))

    assert result.parcels == (
        ParcelOutcome("refused", "wrong_environment", ()),
        held(FIRST_MATCH),
    )
    assert result.database.matches == (match_of(FIRST_MATCH),)


def test_a_damaged_parcel_is_refused_and_the_next_is_applied() -> None:
    text = FIRST_MATCH.text
    middle = len(text) // 2
    damaged = text[:middle] + ("A" if text[middle] != "A" else "B") + text[middle + 1 :]

    result = applied(DEVELOPMENT.apply(Database(), [damaged, SECOND_MATCH.text], NOON))

    assert result.parcels == (ParcelOutcome("refused", "damaged", ()), held(SECOND_MATCH))
    assert result.database.matches == (match_of(SECOND_MATCH),)


def test_a_record_of_another_kind_is_not_stored_and_said_to_be_for_match_records_only() -> None:
    # In UAT, where the golden vectors are, so the hello record is for this server.
    hello = fortymm_core.Record.decode(bytes.fromhex(HELLO_UAT))
    text = parcel_of(fortymm_core.UAT, hello, record(UAT_MATCH))

    result = applied(MatchDatabase(fortymm_core.UAT).apply(Database(), [text], NOON))

    assert result.parcels == (
        ParcelOutcome(
            "applied",
            None,
            (
                RecordAnswer(hello.id(), "not_stored", "match_records_only"),
                RecordAnswer(bytes.fromhex(UAT_MATCH.id), "held"),
            ),
        ),
    )
    assert [s.record.hex() for s in result.database.records] == [UAT_MATCH.record]


def test_a_record_twice_in_one_parcel_is_stored_once() -> None:
    text = parcel_of(fortymm_core.DEVELOPMENT, record(FIRST_MATCH), record(FIRST_MATCH))

    result = applied(DEVELOPMENT.apply(Database(), [text], NOON))

    answer = RecordAnswer(bytes.fromhex(FIRST_MATCH.id), "held")
    assert result.parcels == (ParcelOutcome("applied", None, (answer, answer)),)
    assert len(result.database.records) == 1


def test_the_matches_are_rebuilt_from_the_records_alone() -> None:
    result = applied(DEVELOPMENT.apply(Database(), [FIRST_MATCH.text, SECOND_MATCH.text], NOON))

    assert matches_of(result.database.records) == result.database.matches
    # A database sent in with its matches altered gets them rebuilt.
    tampered = Database(result.database.records, (match_of(UAT_MATCH),))
    again = applied(DEVELOPMENT.apply(tampered, [FIRST_MATCH.text], LATER))
    assert again.database == result.database


def test_a_parcel_text_over_the_limit_is_refused_before_it_is_parsed() -> None:
    # Parsing ignores spaces, so the padded text is a valid parcel: only its length
    # can refuse it.
    at_limit = FIRST_MATCH.text.ljust(PARCEL_TEXT_LIMIT)
    over_limit = FIRST_MATCH.text.ljust(PARCEL_TEXT_LIMIT + 1)

    assert applied(DEVELOPMENT.apply(Database(), [at_limit], NOON)).parcels == (held(FIRST_MATCH),)
    result = applied(DEVELOPMENT.apply(Database(), [over_limit], NOON))
    assert result.parcels == (ParcelOutcome("refused", "too_long", ()),)
    assert result.database == Database()


def stored(made: Made, arrival: int) -> StoredRecord:
    return StoredRecord(arrival, NOON, "held", bytes.fromhex(made.record))


def test_a_database_holding_what_the_service_would_not_store_is_refused() -> None:
    forged = fortymm_core.Record.from_parts(
        record(FIRST_MATCH).body, record(SECOND_MATCH).signature
    ).to_bytes()
    hello = bytes.fromhex(HELLO_UAT)
    cases = {
        "a record that does not decode": (b"\x00",),
        "a record whose signature does not verify": (forged,),
        "a record of another environment": (bytes.fromhex(UAT_MATCH.record),),
        "a record of another kind": (hello,),
    }
    for what, (bad,) in cases.items():
        database = Database((stored(FIRST_MATCH, 1), StoredRecord(2, NOON, "held", bad)))
        assert DEVELOPMENT.apply(database, [SECOND_MATCH.text], NOON) == InvalidDatabase(1), what

    for what, records in {
        "the same record twice": (stored(FIRST_MATCH, 1), stored(FIRST_MATCH, 2)),
        "arrival numbers out of order": (stored(FIRST_MATCH, 2), stored(SECOND_MATCH, 2)),
    }.items():
        assert DEVELOPMENT.apply(Database(records), [SECOND_MATCH.text], NOON) == InvalidDatabase(
            1
        ), what
