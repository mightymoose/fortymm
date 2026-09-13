"""SQL lifecycle writes revoke bearer access as the service lifecycle does."""

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import Account
from app.models.user_token import SessionToken
from app.sessions import get_optional_user, hash_token

CREDENTIALS = [
    (
        "account_session_tokens",
        "user_id",
        "id,user_id,token",
        "gen_random_uuid(),:account,decode('abcd','hex')",
    ),
    (
        "account_email_tokens",
        "user_id",
        "id,user_id,purpose,token,sent_to",
        "gen_random_uuid(),:account,'change',decode('abcd','hex'),'next@example.com'",
    ),
    (
        "account_email_tokens",
        "target_account_id",
        "id,user_id,target_account_id,purpose,token,sent_to",
        "gen_random_uuid(),:other,:account,'merge',decode('abcd','hex'),'next@example.com'",
    ),
    (
        "account_email_intents",
        "user_id",
        "user_id,purpose,sent_to",
        ":account,'change','next@example.com'",
    ),
    (
        "account_email_intents",
        "target_account_id",
        "user_id,target_account_id,purpose,sent_to",
        ":other,:account,'merge','next@example.com'",
    ),
    (
        "account_first_sign_in_intents",
        "user_id",
        "user_id,email",
        ":account,'next@example.com'",
    ),
]


@pytest.mark.parametrize("same_transaction", [False, True])
async def test_sql_deactivation_does_not_revive_old_cookie(
    db_session, same_transaction
):
    account = Account(email="sql-suspension@example.com", auth0_sub="auth0|retained")
    db_session.add(account)
    await db_session.flush()
    account_id = account.id
    db_session.add(SessionToken(user_id=account_id, token=hash_token("old-cookie")))
    await db_session.commit()
    assert await get_optional_user(session_cookie="old-cookie", db=db_session)

    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": account_id},
    )
    if not same_transaction:
        await db_session.commit()
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=NULL WHERE id=:id"),
        {"id": account_id},
    )
    await db_session.commit()

    assert await get_optional_user(session_cookie="old-cookie", db=db_session) is None
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM login_identities WHERE account_id=:id"),
            {"id": account_id},
        )
        == 1
    )
    assert (
        await db_session.scalar(
            text("SELECT email FROM accounts WHERE id=:id"), {"id": account_id}
        )
        == "sql-suspension@example.com"
    )


@pytest.mark.parametrize("table,column,columns,values", CREDENTIALS)
async def test_sql_deactivation_revokes_pending_access(
    db_session, table, column, columns, values
):
    account, other = Account(), Account()
    db_session.add_all([account, other])
    await db_session.commit()
    account_id = account.id
    await db_session.execute(
        text(f"INSERT INTO {table} ({columns}) VALUES ({values})"),
        {"account": account_id, "other": other.id},
    )
    await db_session.commit()
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": account_id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text(f"SELECT count(*) FROM {table} WHERE {column}=:id"), {"id": account_id}
        )
        == 0
    )


@pytest.mark.parametrize("operation", ["insert", "reparent"])
@pytest.mark.parametrize(
    "table,column,columns,values",
    CREDENTIALS
    + [
        (
            "login_identities",
            "account_id",
            "id,account_id,issuer,provider,subject",
            "gen_random_uuid(),:account,'test-issuer','auth0','test-subject'",
        )
    ],
)
async def test_sql_cannot_issue_credentials_for_inactive_accounts(
    db_session, operation, table, column, columns, values
):
    inactive, active, other = Account(), Account(), Account()
    db_session.add_all([inactive, active, other])
    await db_session.commit()
    inactive_id, active_id, other_id = inactive.id, active.id, other.id
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": inactive_id},
    )
    await db_session.commit()
    insert = text(f"INSERT INTO {table} ({columns}) VALUES ({values})")
    if operation == "reparent":
        await db_session.execute(insert, {"account": active_id, "other": other_id})
        await db_session.commit()
    with pytest.raises(IntegrityError, match="inactive account credentials"):
        async with db_session.begin_nested():
            if operation == "insert":
                await db_session.execute(
                    insert, {"account": inactive_id, "other": other_id}
                )
            else:
                await db_session.execute(
                    text(
                        f"UPDATE {table} SET {column}=:inactive WHERE {column}=:active"
                    ),
                    {"inactive": inactive_id, "active": active_id},
                )


@pytest.mark.parametrize("first", ["deactivation", "credential"])
@pytest.mark.parametrize("role", ["owner", "target", "login"])
async def test_sql_deactivation_serializes_with_credential_issuance(
    db_session, engine, first, role
):
    account, other = Account(), Account()
    db_session.add_all([account, other])
    await db_session.commit()
    account_id, other_id = account.id, other.id
    statement = (
        "INSERT INTO account_session_tokens(id,user_id,token) "
        "VALUES(gen_random_uuid(),:id,decode('cdef','hex'))"
        if role == "owner"
        else "INSERT INTO account_email_tokens"
        "(id,user_id,target_account_id,purpose,token,sent_to) "
        "VALUES(gen_random_uuid(),:other,:id,'merge',decode('cdef','hex'),'to@example.com')"
    )
    if role == "login":
        statement = (
            "INSERT INTO login_identities(id,account_id,issuer,provider,subject) "
            "VALUES(gen_random_uuid(),:id,'race-issuer','auth0','race-subject')"
        )
    sessions = async_sessionmaker(engine)
    async with sessions() as suspender, sessions() as issuer:
        suspend_pid = await suspender.scalar(text("SELECT pg_backend_pid()"))
        issue_pid = await issuer.scalar(text("SELECT pg_backend_pid()"))
        suspend = text(
            "UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"
        )
        issue = text(statement)
        parameters = {"id": account_id, "other": other_id}
        if first == "deactivation":
            await suspender.execute(suspend, parameters)
            waiting = asyncio.create_task(issuer.execute(issue, parameters))
            blocker, blocked = suspend_pid, issue_pid
        else:
            await issuer.execute(issue, parameters)
            waiting = asyncio.create_task(suspender.execute(suspend, parameters))
            blocker, blocked = issue_pid, suspend_pid
        try:
            async with asyncio.timeout(5):
                while blocker not in await db_session.scalar(
                    text("SELECT pg_blocking_pids(:pid)"), {"pid": blocked}
                ):
                    if waiting.done():
                        await waiting
                        pytest.fail(
                            "deactivation and credential issuance did not serialize"
                        )
                    await asyncio.sleep(0.01)
            if first == "deactivation":
                await suspender.commit()
                with pytest.raises(
                    IntegrityError, match="inactive account credentials"
                ):
                    await waiting
                await issuer.rollback()
            else:
                await issuer.commit()
                await waiting
                await suspender.commit()
        finally:
            if not waiting.done():
                waiting.cancel()
                await asyncio.gather(waiting, return_exceptions=True)

    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=NULL WHERE id=:id"),
        {"id": account_id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_session_tokens"))
        == 0
    )
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_tokens")) == 0
    )

    if role == "login":
        assert await db_session.scalar(
            text("SELECT count(*) FROM login_identities WHERE account_id=:id"),
            {"id": account_id},
        ) == (1 if first == "credential" else 0)


@pytest.mark.parametrize("field", ["issuer", "provider", "subject"])
async def test_suspended_login_identity_is_retained_but_cannot_change_credential(
    db_session, field
):
    account = Account(auth0_sub="auth0|existing")
    db_session.add(account)
    await db_session.commit()
    account_id = account.id
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": account_id},
    )
    await db_session.commit()
    # An unchanged identity remains valid retained state during suspension.
    await db_session.execute(
        text("UPDATE login_identities SET account_id=account_id WHERE account_id=:id"),
        {"id": account_id},
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="inactive account credentials"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    f"UPDATE login_identities SET {field}='replacement' "
                    "WHERE account_id=:id"
                ),
                {"id": account_id},
            )
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=NULL WHERE id=:id"),
        {"id": account_id},
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT subject FROM login_identities WHERE account_id=:id"),
            {"id": account_id},
        )
        == "auth0|existing"
    )
