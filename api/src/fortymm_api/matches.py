"""The ids and fixed details of matches. A match's players, format and
`rated` never change once it exists (#181). A signed result names its match
by MatchId (signed_results.py). #188 adds the `matches` table and puts
MatchId in models.py's type_annotation_map."""

from typing import Literal, NewType
from uuid import UUID

# A client makes it, so a result can reach the server before its match (#188).
MatchId = NewType("MatchId", UUID)

type BestOf = Literal[3, 5, 7]
