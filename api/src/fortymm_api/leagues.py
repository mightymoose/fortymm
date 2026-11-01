"""The ids of leagues. A league is the scope a match, and later a rating,
belongs to. Exactly one default league exists, and the
`players_join_default_league` trigger joins every new player to it."""

from typing import NewType
from uuid import UUID

LeagueId = NewType("LeagueId", UUID)
