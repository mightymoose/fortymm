"""Email intent validation shared by resend, confirmation and link previews.

Callers own the transaction; this module never commits or sends mail.
"""

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import add_user_to_default_league
from app.models import (
    EmailIntent,
    EmailPurpose,
    EmailToken,
    FirstSignInIntent,
    SessionToken,
    User,
)
from app.roles import grant_default_role
from app.token_hashing import hash_token
from app.usernames import generate_username


async def email_action_is_valid(
    db: AsyncSession, action: EmailIntent | EmailToken
) -> bool:
    owner = await db.get(User, action.user_id)
    if owner is None or not owner.is_active:
        return False
    if action.purpose == EmailPurpose.merge:
        target = (
            await db.get(User, action.target_account_id)
            if action.target_account_id is not None
            else None
        )
        return (
            target is not None and target.is_active and target.email == action.sent_to
        )
    if action.purpose == EmailPurpose.change:
        if owner.email != action.prior_email:
            return False
    elif action.purpose == EmailPurpose.first_sign_in:
        if owner.email is not None or owner.confirmed_at is not None:
            return False
    else:
        return owner.email == action.sent_to
    claimed = (
        await db.execute(
            select(User.id).where(User.email == action.sent_to, User.id != owner.id)
        )
    ).scalar_one_or_none()
    return action.sent_to is not None and claimed is None


async def lock_accounts(db: AsyncSession, account_ids: set[uuid.UUID]) -> None:
    """Lock in one order before credential rows; refresh already-loaded owners."""
    await db.execute(
        select(User)
        .where(User.id.in_(account_ids))
        .order_by(User.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def lock_credential_accounts(
    db: AsyncSession, token_hash: bytes, session_hash: bytes | None
) -> None:
    """Peek only to find locks, then the caller reloads the credential under them.

    Include the browser source and recorded merge endpoints before any row lock;
    opposing account switches therefore use the same Account/session lock order.
    """
    credential = (
        await db.execute(select(EmailToken).where(EmailToken.token == token_hash))
    ).scalar_one_or_none()
    if credential is None:
        return
    account_ids = {credential.user_id}
    if credential.target_account_id is not None:
        account_ids.add(credential.target_account_id)
    if credential.guest_account_id is not None:
        account_ids.add(credential.guest_account_id)
    if session_hash is not None:
        source_id = (
            await db.execute(
                select(SessionToken.user_id).where(SessionToken.token == session_hash)
            )
        ).scalar_one_or_none()
        if source_id is not None:
            account_ids.add(source_id)
    await lock_accounts(db, account_ids)


LOGIN_TOKEN_LIFETIME = timedelta(minutes=15)
EMAIL_CONFIRM_TOKEN_LIFETIME = timedelta(hours=24)


def login_token_clause() -> ColumnElement[bool]:
    return EmailToken.purpose.in_([EmailPurpose.login, EmailPurpose.first_sign_in])


def pending_email_token_clause() -> ColumnElement[bool]:
    return EmailToken.purpose.in_([EmailPurpose.change, EmailPurpose.merge])


async def discard_login_action(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(
        delete(EmailToken).where(EmailToken.user_id == user_id, login_token_clause())
    )
    await db.execute(
        delete(FirstSignInIntent).where(FirstSignInIntent.user_id == user_id)
    )


async def discard_failed_credential(
    db: AsyncSession, token_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Recover after rollback without deleting a subsequently issued action.

    Rollback released every lock. Reacquire the owner before checking whether
    the failed credential still represents the current action.
    """
    await lock_accounts(db, {user_id})
    failed = (
        await db.execute(
            select(EmailToken)
            .where(EmailToken.id == token_id, EmailToken.user_id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if failed is None or failed.replaced_at is not None:
        return
    if failed.purpose in (EmailPurpose.login, EmailPurpose.first_sign_in):
        await discard_login_action(db, user_id)
    else:
        await db.execute(
            delete(EmailToken).where(
                EmailToken.user_id == user_id, pending_email_token_clause()
            )
        )
        await db.execute(delete(EmailIntent).where(EmailIntent.user_id == user_id))


async def has_usable_replacement(
    db: AsyncSession, user_id: uuid.UUID, purpose: EmailPurpose
) -> bool:
    login = purpose in (EmailPurpose.login, EmailPurpose.first_sign_in)
    family = login_token_clause() if login else pending_email_token_clause()
    lifetime = LOGIN_TOKEN_LIFETIME if login else EMAIL_CONFIRM_TOKEN_LIFETIME
    live = (
        await db.execute(
            select(EmailToken).where(
                EmailToken.user_id == user_id,
                family,
                EmailToken.replaced_at.is_(None),
                EmailToken.created_at >= datetime.now(UTC) - lifetime,
            )
        )
    ).scalar_one_or_none()
    return live is not None and await email_action_is_valid(db, live)


async def replace_credential(
    db: AsyncSession,
    user_id: uuid.UUID,
    sent_to: str,
    purpose: EmailPurpose,
    *,
    prior_email: str | None = None,
    target_account_id: uuid.UUID | None = None,
    guest_account_id: uuid.UUID | None = None,
) -> str:
    """Replace one credential family while retaining only reportable old hashes.

    The caller holds the owner lock. Queue delivery and commit remain in the
    caller's transaction so a queue failure rolls the replacement back.
    """
    login = purpose in (EmailPurpose.login, EmailPurpose.first_sign_in)
    family = login_token_clause() if login else pending_email_token_clause()
    lifetime = LOGIN_TOKEN_LIFETIME if login else EMAIL_CONFIRM_TOKEN_LIFETIME
    now = datetime.now(UTC)
    await db.execute(
        delete(EmailToken).where(
            EmailToken.user_id == user_id,
            family,
            EmailToken.created_at < now - lifetime,
        )
    )
    await db.execute(
        update(EmailToken)
        .where(EmailToken.user_id == user_id, family, EmailToken.replaced_at.is_(None))
        .values(
            replaced_at=now,
            sent_to=None,
            prior_email=None,
            target_account_id=None,
            guest_account_id=None,
        )
    )
    raw = secrets.token_urlsafe(32)
    db.add(
        EmailToken(
            user_id=user_id,
            purpose=purpose,
            sent_to=sent_to,
            prior_email=prior_email,
            target_account_id=target_account_id,
            guest_account_id=guest_account_id,
            token=hash_token(raw),
            created_at=now,
        )
    )
    return raw


async def issue_confirmation_token(
    db: AsyncSession,
    user: User,
    sent_to: str,
    purpose: EmailPurpose,
    *,
    prior_email: str | None = None,
    target_account_id: uuid.UUID | None = None,
) -> str:
    intent = await db.get(EmailIntent, user.id)
    if intent is None:
        intent = EmailIntent(user_id=user.id)
        db.add(intent)
    intent.purpose = purpose
    intent.sent_to = sent_to
    intent.prior_email = prior_email
    intent.target_account_id = target_account_id
    return await replace_credential(
        db,
        user.id,
        sent_to,
        purpose,
        prior_email=prior_email,
        target_account_id=target_account_id,
    )


async def lock_pending_email_action(
    db: AsyncSession, user_id: uuid.UUID
) -> EmailIntent | None:
    """Lock the source and destination before reading authoritative intent.

    Replacement can change the destination while locks are being acquired. In
    that case release the old lock set and retry in sorted order, rather than
    acquiring a newly discovered Account out of order.
    """
    while True:
        intent = (
            await db.execute(
                select(EmailIntent)
                .where(EmailIntent.user_id == user_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        account_ids = {user_id}
        if intent is not None and intent.target_account_id is not None:
            account_ids.add(intent.target_account_id)
        await lock_accounts(db, account_ids)
        intent = (
            await db.execute(
                select(EmailIntent)
                .where(EmailIntent.user_id == user_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if (
            intent is not None
            and intent.target_account_id is not None
            and intent.target_account_id not in account_ids
        ):
            await db.rollback()
            continue
        return intent


async def resolve_login_recipient(db: AsyncSession, email: str) -> tuple[User, bool]:
    """Resolve after locking; restart if the address moved to another Account.

    The email advisory lock covers absent intent rows. Acquire every candidate
    Account in sorted order before modifying intent, matching consumption.
    Reads after locking decide the action; the earlier snapshot only finds locks.
    """
    while True:
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:email, 1679))"),
            {"email": email},
        )
        registered = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        intent = (
            await db.execute(
                select(FirstSignInIntent)
                .where(FirstSignInIntent.email == email)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        account_ids = set()
        if registered is not None:
            account_ids.add(registered.id)
        if intent is not None:
            account_ids.add(intent.user_id)
        if account_ids:
            await lock_accounts(db, account_ids)
        registered = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        intent = (
            await db.execute(
                select(FirstSignInIntent)
                .where(FirstSignInIntent.email == email)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if (registered is not None and registered.id not in account_ids) or (
            intent is not None and intent.user_id not in account_ids
        ):
            # An external email writer changed the recipient while we waited.
            # Drop all locks before acquiring the new set in its canonical order.
            await db.rollback()
            continue
        if registered is not None:
            if intent is not None:
                await db.execute(
                    delete(EmailToken).where(
                        EmailToken.user_id == intent.user_id,
                        EmailToken.purpose == EmailPurpose.first_sign_in,
                    )
                )
                await db.delete(intent)
            return registered, False
        if intent is not None:
            pending = await db.get(User, intent.user_id)
            if (
                pending is not None
                and pending.email is None
                and pending.confirmed_at is None
                and pending.merged_into_user_id is None
            ):
                return pending, True
            await db.execute(
                delete(EmailToken).where(
                    EmailToken.user_id == intent.user_id,
                    EmailToken.purpose == EmailPurpose.first_sign_in,
                )
            )
            await db.delete(intent)
            await db.flush()
        pending = await _mint_pending_user(db)
        db.add(FirstSignInIntent(email=email, user_id=pending.id))
        return pending, True


async def _mint_pending_user(db: AsyncSession) -> User:
    """Create the account a first-sign-in link will confirm. Mirrors
    ``_create_session``'s membership setup — default league, default user role
    (ADR-0016) — but mints no session token: nobody is signed in yet, and the
    mailed link is the only thing that can claim this row."""
    user = User(username=await generate_username(db))
    db.add(user)
    await db.flush()
    await add_user_to_default_league(db, user.player_id)
    await grant_default_role(db, user.id)
    return user
