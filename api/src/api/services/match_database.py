"""Applying parcels of `match` records to a database the caller supplies.

TEMPORARY: this stands in for the real intake (design section 7, "Intake") until it
exists, so that state bugs can be found by hand and by replaying inputs. The "database"
is a value passed in and returned, never stored: the server keeps nothing between calls.
It takes `match` records only.

Same input, same output: nothing here reads a clock or a random source. The time of
arrival is a parameter and arrival numbers come from the database.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

import fortymm_core

# The longest parcel text taken, in characters, counted before anything is parsed.
# Parsing has no size limit of its own yet (core review A1: a small hostile parcel can
# expand to hundreds of megabytes). A match parcel is about 610 characters (design
# section 6); 8,000 holds a dozen, and bounds what parsing can be made to allocate to a
# few megabytes.
PARCEL_TEXT_LIMIT = 8_000

Answer = Literal["held", "malformed", "not_stored"]
RecordReason = Literal["bad_signature", "match_records_only"]
ParcelReason = Literal["too_long", "damaged", "wrong_environment"]


@dataclass(frozen=True)
class StoredRecord:
    """A record the database holds, with what was written when it was stored."""

    arrival: int
    arrived_at: datetime
    answer: Literal["held"]
    # The standalone record ([body, signature]).
    record: bytes


@dataclass(frozen=True)
class Match:
    """A match, derived from its `match` record."""

    match_id: bytes
    sides: tuple[tuple[bytes, ...], tuple[bytes, ...]]
    terms: bytes
    # The signer's 33-byte key: the key that created the match.
    created_by: bytes


@dataclass(frozen=True)
class Database:
    """What the real database would hold for match records: the records, in arrival
    order, and the matches derived from them, ordered by match id."""

    records: tuple[StoredRecord, ...] = ()
    matches: tuple[Match, ...] = ()


@dataclass(frozen=True)
class RecordAnswer:
    """What one record of a parcel was answered."""

    record_id: bytes
    answer: Answer
    reason: RecordReason | None = None


@dataclass(frozen=True)
class ParcelOutcome:
    """What happened to one parcel. A refused parcel stores nothing and has no record
    answers; an applied one has an answer for each of its records, in its order."""

    status: Literal["applied", "refused"]
    reason: ParcelReason | None
    records: tuple[RecordAnswer, ...]


@dataclass(frozen=True)
class Applied:
    database: Database
    parcels: tuple[ParcelOutcome, ...]


@dataclass(frozen=True)
class InvalidDatabase:
    """The database given is not one this service could have returned. `index` is the
    stored record at fault."""

    index: int


class MatchDatabase:
    """Applies parcels the way the server's intake would, to a database passed in."""

    def __init__(self, environment: int) -> None:
        self._environment = environment

    def apply(
        self, database: Database, parcels: Sequence[str], arrived_at: datetime
    ) -> Applied | InvalidDatabase:
        """Apply each parcel in order, as if each were its own submit. A refused parcel
        changes nothing and does not stop the ones after it. The matches in the database
        given are ignored and rebuilt from its records."""
        held: dict[bytes, StoredRecord] = {}
        records: list[StoredRecord] = []
        for index, stored in enumerate(database.records):
            record_id = self._valid_stored_id(stored, records)
            if record_id is None or record_id in held:
                return InvalidDatabase(index)
            held[record_id] = stored
            records.append(stored)

        outcomes = []
        for text in parcels:
            outcome = self._apply_parcel(text, arrived_at, held, records)
            outcomes.append(outcome)
        return Applied(Database(tuple(records), matches_of(records)), tuple(outcomes))

    def _valid_stored_id(self, stored: StoredRecord, before: list[StoredRecord]) -> bytes | None:
        # A stored record must be one this service would have stored: it decodes, is a
        # match for this environment, verifies, and arrived after the one before it.
        try:
            record = fortymm_core.Record.decode(stored.record)
        except fortymm_core.Malformed:
            return None
        if (
            record.sides is None
            or record.environment != self._environment
            or not record.verify()
            or stored.arrival < 1
            or (before and stored.arrival <= before[-1].arrival)
        ):
            return None
        return record.id()

    def _apply_parcel(
        self,
        text: str,
        arrived_at: datetime,
        held: dict[bytes, StoredRecord],
        records: list[StoredRecord],
    ) -> ParcelOutcome:
        if len(text) > PARCEL_TEXT_LIMIT:
            return ParcelOutcome("refused", "too_long", ())
        try:
            parcel = fortymm_core.Parcel.parse(text)
        except fortymm_core.Damaged:
            return ParcelOutcome("refused", "damaged", ())
        # Parsing checks that every record carries the parcel's environment.
        if parcel.environment != self._environment:
            return ParcelOutcome("refused", "wrong_environment", ())

        answers = []
        for record in parcel.records:
            record_id = record.id()
            # Intake step 2: a record already held gets its stored answer, unchecked.
            if record_id in held:
                answers.append(RecordAnswer(record_id, held[record_id].answer))
                continue
            # Step 3. A Record has ids before it is verified (core review A3).
            if not record.verify():
                answers.append(RecordAnswer(record_id, "malformed", "bad_signature"))
                continue
            # Only a match this library interpreted has sides (core review C2: the
            # kind's name alone is given even for a format version it cannot read).
            if record.sides is None:
                answers.append(RecordAnswer(record_id, "not_stored", "match_records_only"))
                continue
            # Step 4, the storage budget, is out of scope. Step 5: a match is not a
            # request, so its answer is "held".
            arrival = records[-1].arrival + 1 if records else 1
            stored = StoredRecord(arrival, arrived_at, "held", record.to_bytes())
            held[record_id] = stored
            records.append(stored)
            answers.append(RecordAnswer(record_id, "held"))
        return ParcelOutcome("applied", None, tuple(answers))


def matches_of(records: Sequence[StoredRecord]) -> tuple[Match, ...]:
    """The matches derived from stored records, by match id. Reads nothing else."""
    matches = []
    for stored in records:
        record = fortymm_core.Record.decode(stored.record)
        match_id, sides, terms = record.match_id(), record.sides, record.terms
        if match_id is None or sides is None or terms is None:
            continue
        first, second = sides
        matches.append(Match(match_id, (tuple(first), tuple(second)), terms, record.signer))
    return tuple(sorted(matches, key=lambda match: match.match_id))
