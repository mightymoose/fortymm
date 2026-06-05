from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel


class Status(StrEnum):
    # Values mirror the web client's canonical status buckets (the matches-list
    # filter tabs / StatusKey in web-client/src/routes/matches/index.tsx):
    # 'scheduled' | 'live' | 'final'.
    SCHEDULED = "scheduled"
    LIVE = "live"
    FINAL = "final"


class Scoreboard(BaseModel):
    status: Status


class MatchDetails(BaseModel):
    scoreboard: Scoreboard
