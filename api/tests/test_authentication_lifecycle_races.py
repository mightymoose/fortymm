"""Authentication and profile changes respect Account suspension ordering."""

import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.auth0_identity import resolve_linked_user
from app.identity_lifecycle import deactivate_account
from app.models import Account
from app.sessions import UpdateCurrentUserRequest, update_current_user
from tests._helpers import make_user
from tests.test_proposal_history import wait_for_blocked


@pytest.mark.parametrize("first", ["authentication", "deactivation"])
async def test_linked_authentication_serializes_with_deactivation(
    db_session, engine, first
):
    actor = await make_user(db_session, "linked-auth-race")
    actor.auth0_sub = "auth0|linked-race"
    await db_session.commit()
    actor_id = actor.id
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as verifier, factory() as lifecycle:
        await verifier.get(Account, actor_id)  # Exercise an already-loaded identity.
        verifier_pid = await verifier.scalar(text("SELECT pg_backend_pid()"))
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        if first == "deactivation":
            await deactivate_account(lifecycle, actor_id)
            pending = asyncio.create_task(
                resolve_linked_user(verifier, "auth0|linked-race")
            )
            try:
                await wait_for_blocked(lifecycle, verifier_pid, pending)
                await lifecycle.commit()
                assert await pending is None
            finally:
                if not pending.done():
                    pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
        else:
            assert await resolve_linked_user(verifier, "auth0|linked-race") is not None
            pending = asyncio.create_task(deactivate_account(lifecycle, actor_id))
            try:
                await wait_for_blocked(verifier, lifecycle_pid, pending)
                await verifier.commit()
                await pending
                await lifecycle.commit()
            finally:
                if not pending.done():
                    pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)


async def test_profile_change_rejects_stale_authority_after_deactivation(
    db_session, engine
):
    actor = await make_user(db_session, "profile-before-suspension")
    await db_session.commit()
    actor_id = actor.id
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as writer, factory() as lifecycle:
        stale_actor = await writer.get(Account, actor_id)
        writer_pid = await writer.scalar(text("SELECT pg_backend_pid()"))
        await deactivate_account(lifecycle, actor_id)
        pending = asyncio.create_task(
            update_current_user(
                UpdateCurrentUserRequest(username="profile-after-suspension"),
                db=writer,
                current_user=stale_actor,
            )
        )
        try:
            await wait_for_blocked(lifecycle, writer_pid, pending)
            await lifecycle.commit()
            with pytest.raises(HTTPException) as rejected:
                await pending
            assert rejected.value.status_code == 401
        finally:
            if not pending.done():
                pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
    await db_session.refresh(actor)
    assert actor.username == "profile-before-suspension"


async def test_profile_change_that_wins_finishes_before_deactivation(
    db_session, engine, monkeypatch
):
    from app import sessions

    actor = await make_user(db_session, "profile-wins-race")
    await db_session.commit()
    actor_id = actor.id
    checked, proceed = asyncio.Event(), asyncio.Event()
    original = sessions.name_taken

    async def pause_name_check(*args, **kwargs):
        checked.set()
        await proceed.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(sessions, "name_taken", pause_name_check)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as writer, factory() as lifecycle:
        current_actor = await writer.get(Account, actor_id)
        lifecycle_pid = await lifecycle.scalar(text("SELECT pg_backend_pid()"))
        writing = asyncio.create_task(
            update_current_user(
                UpdateCurrentUserRequest(username="profile-renamed-first"),
                db=writer,
                current_user=current_actor,
            )
        )
        await asyncio.wait_for(checked.wait(), 5)
        suspending = asyncio.create_task(deactivate_account(lifecycle, actor_id))
        try:
            await wait_for_blocked(writer, lifecycle_pid, suspending)
            proceed.set()
            await writing
            await suspending
            await lifecycle.commit()
        finally:
            proceed.set()
            for pending in (writing, suspending):
                if not pending.done():
                    pending.cancel()
            await asyncio.gather(writing, suspending, return_exceptions=True)
    await db_session.refresh(actor)
    assert actor.username == "profile-renamed-first"
