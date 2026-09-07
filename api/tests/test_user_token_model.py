import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SessionToken, User


async def test_create_session_token_assigns_uuid_and_timestamp(
    db_session: AsyncSession,
):
    user = User(username="alice")
    db_session.add(user)
    await db_session.commit()

    token = SessionToken(
        token=b"secret-bytes",
        user_id=user.id,
    )
    db_session.add(token)
    await db_session.commit()
    await db_session.refresh(token)

    assert isinstance(token.id, uuid.UUID)
    assert token.token == b"secret-bytes"
    assert isinstance(token, SessionToken)
    assert token.user_id == user.id
    assert token.created_at is not None


async def test_session_token_requires_account(db_session: AsyncSession):
    db_session.add(
        SessionToken(token=b"x", user_id=None)  # type: ignore[arg-type]
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_session_token_requires_credential_hash(db_session: AsyncSession):
    user = User(username="carol")
    db_session.add(user)
    await db_session.commit()

    db_session.add(
        SessionToken(token=None, user_id=user.id)  # type: ignore[arg-type]
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_session_token_cascades_on_account_delete(db_session: AsyncSession):
    user = User(username="dave")
    db_session.add(user)
    await db_session.commit()

    token = SessionToken(token=b"t", user_id=user.id)
    db_session.add(token)
    await db_session.commit()

    token_id = token.id
    await db_session.delete(user)
    await db_session.commit()
    db_session.expunge_all()

    fetched = await db_session.get(SessionToken, token_id)
    assert fetched is None


async def test_email_credential_schema_has_typed_purpose_and_account_references(
    db_session: AsyncSession,
):
    columns = set(
        (
            await db_session.execute(
                text(
                    "SELECT column_name FROM information_schema.columns WHERE "
                    "table_name = 'account_email_tokens'"
                )
            )
        ).scalars()
    )
    assert {
        "purpose",
        "prior_email",
        "target_account_id",
        "guest_account_id",
    } <= columns
    assert "context" not in columns


async def test_database_rejects_email_credential_merging_account_into_itself(
    db_session: AsyncSession,
):
    owner = User(username="self-merge-owner")
    db_session.add(owner)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="ck_account_email_tokens"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO account_email_tokens "
                    "(id, token, user_id, purpose, sent_to, target_account_id) "
                    "VALUES (:id, :token, :owner, 'merge', 'owner@example.com', :owner)"
                ),
                {
                    "id": uuid.uuid4(),
                    "token": b"synthetic-self-merge",
                    "owner": owner.id,
                },
            )


@pytest.mark.parametrize("purposes", [("login", "first_sign_in"), ("change", "merge")])
async def test_database_allows_only_one_current_credential_per_action_family(
    db_session: AsyncSession, purposes: tuple[str, str]
):
    owner = User(username="credential-owner")
    target = User(username="credential-target")
    db_session.add_all([owner, target])
    await db_session.commit()
    insert = text(
        "INSERT INTO account_email_tokens "
        "(id, token, user_id, purpose, sent_to, target_account_id) "
        "VALUES (:id, :token, :owner, :purpose, 'owner@example.com', :target)"
    )
    first_id = uuid.uuid4()
    await db_session.execute(
        insert,
        {
            "id": first_id,
            "token": b"synthetic-current",
            "owner": owner.id,
            "purpose": purposes[0],
            "target": None,
        },
    )
    replacement = {
        "id": uuid.uuid4(),
        "token": b"synthetic-replacement",
        "owner": owner.id,
        "purpose": purposes[1],
        "target": target.id if purposes[1] == "merge" else None,
    }
    with pytest.raises(IntegrityError, match="duplicate key"):
        async with db_session.begin_nested():
            await db_session.execute(insert, replacement)
    await db_session.execute(
        text(
            "UPDATE account_email_tokens SET replaced_at = now(), sent_to = NULL "
            "WHERE id = :id"
        ),
        {"id": first_id},
    )
    await db_session.execute(insert, replacement)


@pytest.mark.parametrize(
    ("purpose", "prior_email", "has_target", "has_guest", "sent_to", "replaced"),
    [
        ("unknown", None, False, False, "to@example.com", False),
        ("login", "prior@example.com", False, False, "to@example.com", False),
        ("first_sign_in", "prior@example.com", False, False, "to@example.com", False),
        ("change", None, True, False, "to@example.com", False),
        ("change", None, False, True, "to@example.com", False),
        ("merge", None, False, False, "to@example.com", False),
        ("merge", "prior@example.com", True, False, "to@example.com", False),
        ("merge", None, True, True, "to@example.com", False),
        ("login", None, True, False, "to@example.com", False),
        ("login", None, False, False, None, False),
        ("change", None, False, False, "to@example.com", True),
        ("change", "prior@example.com", False, False, None, True),
        ("merge", None, True, False, None, True),
        ("login", None, False, True, None, True),
    ],
)
async def test_database_rejects_email_purpose_payload_mismatches(
    db_session: AsyncSession,
    purpose,
    prior_email,
    has_target,
    has_guest,
    sent_to,
    replaced,
):
    owner = User(username="payload-owner")
    other = User(username="payload-other")
    db_session.add_all([owner, other])
    await db_session.commit()
    with pytest.raises(IntegrityError, match="ck_account_email_tokens"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO account_email_tokens "
                    "(id, token, user_id, purpose, sent_to, prior_email, "
                    "target_account_id, guest_account_id, replaced_at) "
                    "VALUES (:id, :token, :owner, :purpose, :sent_to, :prior_email, "
                    ":target, :guest, :replaced_at)"
                ),
                {
                    "id": uuid.uuid4(),
                    "token": b"synthetic-invalid-payload",
                    "owner": owner.id,
                    "purpose": purpose,
                    "sent_to": sent_to,
                    "prior_email": prior_email,
                    "target": other.id if has_target else None,
                    "guest": other.id if has_guest else None,
                    "replaced_at": datetime.now(UTC) if replaced else None,
                },
            )


@pytest.mark.parametrize("reference", ["owner", "target", "guest"])
async def test_database_rejects_email_credentials_referencing_missing_accounts(
    db_session: AsyncSession, reference: str
):
    owner = User(username="reference-owner")
    db_session.add(owner)
    await db_session.commit()
    missing_id = uuid.uuid4()
    with pytest.raises(IntegrityError, match="foreign key constraint"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO account_email_tokens "
                    "(id, token, user_id, purpose, sent_to, target_account_id, "
                    "guest_account_id) "
                    "VALUES (:id, :token, :owner, :purpose, 'to@example.com', "
                    ":target, :guest)"
                ),
                {
                    "id": uuid.uuid4(),
                    "token": b"synthetic-missing-reference",
                    "owner": missing_id if reference == "owner" else owner.id,
                    "purpose": "merge" if reference == "target" else "login",
                    "target": missing_id if reference == "target" else None,
                    "guest": missing_id if reference == "guest" else None,
                },
            )


@pytest.mark.parametrize(
    ("email", "reuse_owner", "error"),
    [
        ("pending@example.com", False, "duplicate key"),
        ("another@example.com", True, "duplicate key"),
        ("PENDING@example.com", False, "ck_account_first_sign_in_intents"),
    ],
)
async def test_database_requires_unique_normalized_first_sign_in_association(
    db_session: AsyncSession, email: str, reuse_owner: bool, error: str
):
    owner = User(username="pending-owner")
    other = User(username="pending-other")
    db_session.add_all([owner, other])
    await db_session.commit()
    insert = text(
        "INSERT INTO account_first_sign_in_intents (email, user_id) VALUES (:email, "
        ":owner)"
    )
    await db_session.execute(
        insert, {"email": "pending@example.com", "owner": owner.id}
    )
    with pytest.raises(IntegrityError, match=error):
        async with db_session.begin_nested():
            await db_session.execute(
                insert, {"email": email, "owner": owner.id if reuse_owner else other.id}
            )


@pytest.mark.parametrize("is_session", [True, False])
async def test_database_prevents_one_credential_hash_identifying_two_accounts(
    db_session: AsyncSession, is_session: bool
):
    owners = [User(username="hash-owner-one"), User(username="hash-owner-two")]
    db_session.add_all(owners)
    await db_session.commit()
    insert = (
        text(
            "INSERT INTO account_session_tokens (id, token, user_id) VALUES (:id, "
            ":token, :owner)"
        )
        if is_session
        else text(
            "INSERT INTO account_email_tokens (id, token, user_id, purpose, sent_to) "
            "VALUES (:id, :token, :owner, 'login', 'to@example.com')"
        )
    )
    await db_session.execute(
        insert,
        {
            "id": uuid.uuid4(),
            "token": b"synthetic-duplicate-hash",
            "owner": owners[0].id,
        },
    )
    with pytest.raises(IntegrityError, match="duplicate key"):
        async with db_session.begin_nested():
            await db_session.execute(
                insert,
                {
                    "id": uuid.uuid4(),
                    "token": b"synthetic-duplicate-hash",
                    "owner": owners[1].id,
                },
            )


@pytest.mark.parametrize(
    ("purpose", "has_prior", "has_guest", "replaced"),
    [
        ("login", False, False, False),
        ("login", False, True, False),
        ("first_sign_in", False, False, False),
        ("first_sign_in", False, True, False),
        ("change", False, False, False),
        ("change", True, False, False),
        ("merge", False, False, False),
        ("login", False, False, True),
        ("first_sign_in", False, False, True),
        ("change", False, False, True),
        ("merge", False, False, True),
    ],
)
async def test_migrated_database_round_trips_every_supported_email_credential_flavor(
    db_session: AsyncSession,
    purpose: str,
    has_prior: bool,
    has_guest: bool,
    replaced: bool,
):
    owner = User(username="flavor-owner")
    other = User(username="flavor-other")
    db_session.add_all([owner, other])
    await db_session.commit()
    max_email = "a" * 64 + "@" + "b" * 63 + "." + "c" * 63 + "." + "d" * 57 + ".com"
    assert len(max_email) == 254
    expected = {
        "purpose": purpose,
        "sent_to": None if replaced else max_email,
        "prior_email": max_email if has_prior else None,
        "target_account_id": other.id if purpose == "merge" and not replaced else None,
        "guest_account_id": other.id if has_guest else None,
    }
    credential_id = uuid.uuid4()
    await db_session.execute(
        text(
            "INSERT INTO account_email_tokens "
            "(id, token, user_id, purpose, sent_to, prior_email, target_account_id, "
            "guest_account_id, replaced_at) "
            "VALUES (:id, :token, :owner, :purpose, :sent_to, :prior_email, "
            ":target_account_id, :guest_account_id, :replaced_at)"
        ),
        {
            **expected,
            "id": credential_id,
            "token": b"synthetic-flavor-hash",
            "owner": owner.id,
            "replaced_at": datetime.now(UTC) if replaced else None,
        },
    )
    await db_session.commit()
    actual = (
        (
            await db_session.execute(
                text(
                    "SELECT purpose, sent_to, prior_email, target_account_id, "
                    "guest_account_id FROM account_email_tokens WHERE id = :id"
                ),
                {"id": credential_id},
            )
        )
        .mappings()
        .one()
    )
    assert dict(actual) == expected


@pytest.mark.parametrize(
    ("purpose", "target", "prior_email", "error"),
    [
        ("login", None, None, "ck_account_email_intents"),
        ("first_sign_in", None, None, "ck_account_email_intents"),
        ("merge", None, None, "ck_account_email_intents"),
        ("merge", "other", "prior@example.com", "ck_account_email_intents"),
        ("change", "other", None, "ck_account_email_intents"),
        ("merge", "self", None, "ck_account_email_intents"),
        ("merge", "missing", None, "foreign key constraint"),
    ],
)
async def test_database_rejects_invalid_pending_email_actions(
    db_session: AsyncSession, purpose: str, target, prior_email, error: str
):
    owner = User(username="intent-owner")
    other = User(username="intent-other")
    db_session.add_all([owner, other])
    await db_session.commit()
    targets = {None: None, "self": owner.id, "other": other.id, "missing": uuid.uuid4()}
    with pytest.raises(IntegrityError, match=error):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO account_email_intents (user_id, purpose, sent_to, "
                    "prior_email, target_account_id) "
                    "VALUES (:owner, :purpose, 'to@example.com', :prior_email, :target)"
                ),
                {
                    "owner": owner.id,
                    "purpose": purpose,
                    "prior_email": prior_email,
                    "target": targets[target],
                },
            )
