"""Entry creation attribution remains immutable across identity lifecycles."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests._helpers import make_user
from tests.test_tournament_entries import _make_event


async def insert_entry(db_session, event_id, actor_id):
    entry_id = await db_session.scalar(
        text(
            "INSERT INTO tournament_entries(event_id,added_by_user_id,status) "
            "VALUES(:event,:actor,'withdrawn') RETURNING id"
        ),
        {"event": event_id, "actor": actor_id},
    )
    await db_session.commit()
    return entry_id


@pytest.mark.parametrize(
    "original,replacement",
    [
        ("actor", "other"),
        ("actor", "system"),
        ("system", "other"),
    ],
)
async def test_sql_cannot_rewrite_entry_creator(db_session, original, replacement):
    actor = await make_user(db_session, "original-entry-creator")
    other = await make_user(db_session, "replacement-entry-creator")
    event = await _make_event(db_session)
    entry_id = await insert_entry(
        db_session, event.id, actor.id if original == "actor" else None
    )
    with pytest.raises(IntegrityError, match="entry creator is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_entries SET added_by_user_id=:actor WHERE id=:id"
                ),
                {"actor": other.id if replacement == "other" else None, "id": entry_id},
            )


@pytest.mark.parametrize("lifecycle", ["deactivate", "erase", "merge"])
async def test_entry_keeps_original_creator_after_identity_lifecycle(
    db_session, lifecycle
):
    from app.account_merge import merge_user
    from app.identity_lifecycle import deactivate_account, erase_account

    actor = await make_user(db_session, "retained-entry-creator")
    target = await make_user(db_session, "retained-entry-creator-target")
    event = await _make_event(db_session)
    entry_id = await insert_entry(db_session, event.id, actor.id)
    if lifecycle == "deactivate":
        await deactivate_account(db_session, actor.id)
    elif lifecycle == "erase":
        await erase_account(db_session, actor.id)
    else:
        await merge_user(db_session, from_user_id=actor.id, to_user_id=target.id)
    await db_session.commit()
    await db_session.execute(
        text(
            "UPDATE tournament_entries SET added_by_user_id=added_by_user_id "
            "WHERE id=:id"
        ),
        {"id": entry_id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT added_by_user_id FROM tournament_entries WHERE id=:id"),
            {"id": entry_id},
        )
        == actor.id
    )


async def test_initial_system_entry_keeps_null_creator(db_session):
    event = await _make_event(db_session)
    entry_id = await insert_entry(db_session, event.id, None)
    await db_session.execute(
        text("UPDATE tournament_entries SET added_by_user_id=NULL WHERE id=:id"),
        {"id": entry_id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT added_by_user_id FROM tournament_entries WHERE id=:id"),
            {"id": entry_id},
        )
        is None
    )
