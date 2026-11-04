"""What adoption and player merge do to each foreign key to `accounts` and
`players`. tests/test_ownership.py fails when a foreign key has no entry.

Player merge (services/player_merge.py) keeps every row that names the merged
player. Only the account's own rows change kind. The merged player's row
becomes `managed`, and the survivor's row takes the relationship of the
player it merged into: `self` or `managed`.
"""

from enum import StrEnum


class OwnershipRule(StrEnum):
    MOVES_ON_ADOPT = "moves_on_adopt"
    SET_BY_ADOPT = "set_by_adopt"
    NAMES_ADOPTION_SOURCE = "names_adoption_source"
    REVOKED_ON_GUEST_CONVERSION = "revoked_on_guest_conversion"
    STAYS_ON_PLAYER_MERGE = "stays_on_player_merge"
    SET_BY_PLAYER_MERGE = "set_by_player_merge"
    GUEST_HAS_NONE = "guest_has_none"
    # Who did something to a match. Adoption leaves it naming the guest,
    # whose row stays with adopted_into set.
    KEPT_AS_RECORD = "kept_as_record"


OWNERSHIP_RULES: dict[tuple[str, str], OwnershipRule] = {
    ("player_managers", "account_id"): OwnershipRule.MOVES_ON_ADOPT,
    ("player_managers", "player_id"): OwnershipRule.STAYS_ON_PLAYER_MERGE,
    ("player_managers", "adopted_from"): OwnershipRule.NAMES_ADOPTION_SOURCE,
    ("sessions", "account_id"): OwnershipRule.REVOKED_ON_GUEST_CONVERSION,
    ("signing_keys", "account_id"): OwnershipRule.MOVES_ON_ADOPT,
    ("signing_keys", "revoked_by"): OwnershipRule.MOVES_ON_ADOPT,
    ("identities", "account_id"): OwnershipRule.GUEST_HAS_NONE,
    # Only a verified account holds a role, so only one grants a role.
    ("account_roles", "account_id"): OwnershipRule.GUEST_HAS_NONE,
    ("account_roles", "granted_by"): OwnershipRule.GUEST_HAS_NONE,
    ("league_members", "player_id"): OwnershipRule.STAYS_ON_PLAYER_MERGE,
    ("players", "merged_into"): OwnershipRule.SET_BY_PLAYER_MERGE,
    ("accounts", "adopted_into"): OwnershipRule.SET_BY_ADOPT,
    ("matches", "created_by"): OwnershipRule.KEPT_AS_RECORD,
    ("match_side_players", "player_id"): OwnershipRule.STAYS_ON_PLAYER_MERGE,
    ("match_approvals", "account_id"): OwnershipRule.KEPT_AS_RECORD,
    ("match_approvals", "player_id"): OwnershipRule.STAYS_ON_PLAYER_MERGE,
    ("match_submissions", "account_id"): OwnershipRule.KEPT_AS_RECORD,
}
