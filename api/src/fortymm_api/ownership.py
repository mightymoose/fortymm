"""What adoption and player merge do to each foreign key to `accounts` and
`players`. tests/test_ownership.py fails when a foreign key has no entry.
"""

from enum import StrEnum


class OwnershipRule(StrEnum):
    MOVES_ON_ADOPT = "moves_on_adopt"
    SET_BY_ADOPT = "set_by_adopt"
    NAMES_ADOPTION_SOURCE = "names_adoption_source"
    REVOKED_ON_GUEST_CONVERSION = "revoked_on_guest_conversion"
    STAYS_ON_PLAYER_MERGE = "stays_on_player_merge"
    SET_BY_PLAYER_MERGE = "set_by_player_merge"


OWNERSHIP_RULES: dict[tuple[str, str], OwnershipRule] = {
    ("player_managers", "account_id"): OwnershipRule.MOVES_ON_ADOPT,
    ("player_managers", "player_id"): OwnershipRule.STAYS_ON_PLAYER_MERGE,
    ("player_managers", "adopted_from"): OwnershipRule.NAMES_ADOPTION_SOURCE,
    ("sessions", "account_id"): OwnershipRule.REVOKED_ON_GUEST_CONVERSION,
    ("players", "merged_into"): OwnershipRule.SET_BY_PLAYER_MERGE,
    ("accounts", "adopted_into"): OwnershipRule.SET_BY_ADOPT,
}
