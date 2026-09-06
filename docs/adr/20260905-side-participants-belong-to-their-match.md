# Side participants belong to their match

Status: Accepted. Implements #1675.

A participant's `match_id` must agree with the match owning its side. The database
checks `(match_side_id, match_id)` against the unique `(id, match_id)` side key
immediately, with a non-deferrable foreign key. Inserts and updates that disagree
fail; moving a populated side cannot silently move its participants to another match.

The ORM writes `match_id` through the match relationship and `match_side_id` through
the side relationship independently. Contradictory assignments fail on flush rather
than letting one relationship overwrite the other. Existing creation paths already
supply both relationships.

Participation still references durable Players under the accounts/Players ADR.
Uniqueness within a match and within a side, Player deletion restrictions, and
side/match deletion cascades remain unchanged. Solo matches retain their empty
opponent side; singles and doubles remain representable. No prior ADR is superseded.

The disposable pre-beta Alembic baseline is amended in place. Tests exercise SQL
integrity and ORM behavior against both metadata-created and freshly migrated
schemas; the existing migration test also verifies schema parity and catalogue seeds.
