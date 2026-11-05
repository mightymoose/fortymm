"""Player merge: two players that turn out to be one person become one.

Two players who played each other are two people, so they never merge. A
match counts once it has a result, rated or not. Anyone may create a match
naming any two players, so a match with no result would let a stranger
block a merge.

The original player, the one created first, survives. It keeps its id and
display name. The other player gets `merged_into` set and gives up its
display name. Players are permanent, so its row stays.
"""

from collections.abc import Collection
from dataclasses import dataclass

from sqlalchemy import exists, func, select, update
from sqlalchemy.orm import Session, aliased

from fortymm_api.accounts import AccountId, PlayerId
from fortymm_api.models import MatchSidePlayer, Player, PlayerManager, StoredMatchResult


class PlayedEachOther(Exception):
    """The two players were on opposite sides of a match with a result, so
    they are two people. `create_app()` answers 409."""


@dataclass(frozen=True)
class Merged:
    survivor: PlayerId
    merged: PlayerId


def merge_players(
    session: Session, account: AccountId, player: PlayerId, into: PlayerId
) -> Merged:
    """Merge `player` and `into`, two players the account manages. Raises
    PlayedEachOther, before it writes anything, if they played each other.

    The caller holds the account's player_managers rows FOR UPDATE. The
    survivor's row takes the relationship and the `adopted_from` that
    `into`'s row had. So a merge into the self player keeps the account's
    self player, and it never closes an open question on `into` that no one
    answered. The account's row for the merged player stays, as `managed`
    with no question (STAYS_ON_PLAYER_MERGE).
    """
    target = session.execute(
        select(PlayerManager.relationship, PlayerManager.adopted_from).where(
            PlayerManager.account_id == account, PlayerManager.player_id == into
        )
    ).one_or_none()
    if target is None:
        raise ValueError(f"Account {account} doesn't manage player {into}")
    relationship, adopted_from = target
    # FOR UPDATE on both players, so two merges of one player take turns.
    survivor, merged = session.scalars(
        select(Player.id)
        .where(Player.id.in_([into, player]))
        # Players made in one transaction share created_at, so id breaks a tie.
        .order_by(Player.created_at, Player.id)
        .with_for_update()
    ).all()
    # A side player of a match may be one already merged into either
    # player. Locking those too makes a writer that holds a match's side
    # players FOR SHARE take turns with this merge, so the later one sees
    # the earlier.
    session.execute(
        select(Player.id)
        .where(Player.merged_into.in_([into, player]))
        .with_for_update()
    )
    if merged in opponents(session, [survivor])[survivor]:
        raise PlayedEachOther

    session.execute(
        update(Player)
        .where((Player.id == merged) | (Player.merged_into == merged))
        .values(merged_into=survivor)
    )
    # Each statement runs alone, because the self indexes aren't deferrable:
    # the old self row stops being 'self' before the survivor's row starts.
    for found, becomes, asked_by in (
        (merged, "managed", None),
        (survivor, relationship, adopted_from),
    ):
        session.execute(
            update(PlayerManager)
            .where(
                PlayerManager.account_id == account, PlayerManager.player_id == found
            )
            .values(relationship=becomes, adopted_from=asked_by)
        )
    return Merged(survivor, merged)


def opponents(
    session: Session, players: Collection[PlayerId]
) -> dict[PlayerId, frozenset[PlayerId]]:
    """Whom each of `players`, none of them merged, played in a match with
    a result. Each counts together with the players merged into it, and
    each opponent is named by its survivor."""
    mine, theirs = aliased(MatchSidePlayer), aliased(MatchSidePlayer)
    me, them = aliased(Player), aliased(Player)
    rows = session.execute(
        select(
            func.coalesce(me.merged_into, me.id),
            func.coalesce(them.merged_into, them.id),
        )
        .distinct()
        .select_from(mine)
        .join(me, me.id == mine.player_id)
        .join(
            theirs,
            (theirs.match_id == mine.match_id)
            & (theirs.match_side_id != mine.match_side_id),
        )
        .join(them, them.id == theirs.player_id)
        .where(
            me.id.in_(players) | me.merged_into.in_(players),
            exists().where(StoredMatchResult.match_id == mine.match_id),
        )
    )
    found: dict[PlayerId, set[PlayerId]] = {player: set() for player in players}
    for player, opponent in rows:
        found[player].add(opponent)
    return {player: frozenset(played) for player, played in found.items()}
