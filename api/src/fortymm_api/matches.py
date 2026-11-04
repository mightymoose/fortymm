"""The ids and fixed details of matches. A match's players, format and
`rated` never change once it exists (#181)."""

from typing import Literal, NewType
from uuid import UUID

# A client makes it, so a result can reach the server before its match (#188).
MatchId = NewType("MatchId", UUID)

# A row of match_results. A client names a result by its payload's hash
# instead, since it can't know this id.
MatchResultId = NewType("MatchResultId", UUID)

type BestOf = Literal[1, 3, 5, 7]
