"""Domain models for a match: in-process, storage-agnostic shapes that the
repository builds from persisted rows and that mappers turn into ``schemas.view``
response models. They are general representations of the match entity — not
tied to any one view or endpoint. They hold the fields the domain currently
needs and grow as more of the read path migrates onto them."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.models.match import Match as MatchRow
from app.models.match import MatchStatus


@dataclass(frozen=True)
class Match:
    id: uuid.UUID
    status: MatchStatus

    @classmethod
    def from_row(cls, row: MatchRow) -> Match:
        """Build from an already-loaded ORM row — for callers that hold the
        full match and want to avoid a second query."""
        return cls(id=row.id, status=row.status)
