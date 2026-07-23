"""Resolve-or-provision a fortymm ``User`` from a verified Auth0 token.

At MCP token time the OAuth Resource-Server verifier turns a valid Auth0 token
into the fortymm ``User`` it acts as. This module owns the second half of that:
when the token's ``sub`` isn't yet linked, it *matches* the token's verified
email to an existing account (binding the ``sub``) or *provisions* a fresh
registered account on it. See ADR
``20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email``.

Router-free (no FastAPI imports), the same discipline as ``app.auth0_identity``,
so the MCP verifier can import it without dragging in a router — and the sub
lookup itself is reused from there (``resolve_linked_user``), never
reimplemented.
"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth0_identity import resolve_linked_user
from app.leagues import add_user_to_default_league
from app.models import User
from app.roles import grant_default_role
from app.usernames import generate_username

# The two namespaced claim keys the Auth0 Action ships on the MCP access token
# (see ``docs/auth0-mcp-email-claims-action.md``). Auth0 silently drops
# non-namespaced custom claims, so these must stay namespaced URLs — and must
# stay in lockstep with the Action's namespace, or the feature goes dark.
AUTH0_EMAIL_CLAIM = "https://fortymm.com/email"
AUTH0_EMAIL_VERIFIED_CLAIM = "https://fortymm.com/email_verified"


async def _resolve_live_user_by_email(db: AsyncSession, email: str) -> User | None:
    """The live (non-tombstoned) user holding ``email``, or ``None``.

    ``email`` is expected already lowercased — the email-change/confirm flow
    stores addresses lowercased, so both the match query and any provisioned row
    carry the same canonical form.
    """
    result = await db.execute(
        select(User).where(
            User.email == email,
            User.merged_into_user_id.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def resolve_or_provision_user(
    db: AsyncSession,
    sub: str,
    email: str | None,
    email_verified: bool,
) -> User | None:
    """Turn a verified Auth0 token into the fortymm ``User`` it acts as.

    1. **Linked sub** → the user who already linked ``sub`` (reusing
       ``resolve_linked_user``).
    2. **Verified email present** (``email`` truthy and ``email_verified`` is
       ``True``):
       - an existing live account holds that email (case-insensitive) → bind
         ``auth0_sub`` to it and return it (**match**) — unless it already holds
         a *different* ``auth0_sub``, in which case return ``None`` (see below);
       - no account holds it → create a registered account (coolname username,
         email set, ``confirmed_at`` stamped, ``auth0_sub`` bound, default role +
         default league) and return it (**provision**).
    3. **No email, or ``email_verified`` not ``True``** → ``None``. We never
       match or provision off an address the caller hasn't proven they control.

    Writes on the first token for a new identity (a bind, or an INSERT); every
    later token resolves via step 1 with no write.
    """
    # (1) Already linked — the common steady-state path, and a no-op write-wise.
    existing = await resolve_linked_user(db, sub)
    if existing is not None:
        return existing

    # (3) Without a proven-controlled email there is nothing safe to match or
    # provision against.
    if not email or email_verified is not True:
        return None

    # (2) Match the verified email against a live account, canonicalising to the
    # lowercased form the email-confirm flow stores.
    email = email.lower()
    matched = await _resolve_live_user_by_email(db, email)
    if matched is not None:
        if matched.auth0_sub is None:
            matched.auth0_sub = sub
            try:
                await db.commit()
            except IntegrityError:
                # A concurrent bind of the same ``sub`` to a *different* row (e.g.
                # a manual ``/auth0/link`` in flight) wins the unique
                # ``users.auth0_sub`` constraint first. Same guard as
                # ``_provision_user`` / ``_bind_auth0_sub``: roll back and
                # re-resolve (by ``sub``, then by email) so the loser returns the
                # winning row instead of raising.
                await db.rollback()
                winner = await resolve_linked_user(db, sub)
                if winner is not None:
                    return winner
                return await _resolve_live_user_by_email(db, email)
            return matched
        # A *different* Auth0 identity claims an already-linked email — the same
        # ``sub`` would already have returned at step 1 (``resolve_linked_user``),
        # so ``matched.auth0_sub`` here is necessarily some other identity. Refuse
        # rather than hijack the existing link: a deliberate, non-destructive
        # decision — the second identity gets in only once the first unlinks (or
        # the two accounts are merged by magic-link confirm).
        return None

    # No account holds the email → provision a fresh registered account.
    return await _provision_user(db, sub, email)


async def _provision_user(db: AsyncSession, sub: str, email: str) -> User | None:
    """Create a registered account for a first-seen verified email.

    Born exactly like a normal account (coolname username, ``confirmed_at``
    stamped, default league + default role, in that same order) plus the bound
    ``auth0_sub``. A verified Auth0 email is trusted as equivalent to fortymm's
    own magic-link inbox-proof, so the account is ``confirmed_at``-stamped rather
    than half-real (ADR).

    **Concurrency — match, don't duplicate.** A near-simultaneous second request
    for the same identity can win the INSERT first; the unique constraints on
    ``users.email`` / ``users.auth0_sub`` then raise ``IntegrityError`` here. We
    catch it, roll back, and re-resolve (by ``sub``, then by email) so the loser
    returns the winning row instead of raising.
    """
    user = User(
        username=await generate_username(db),
        email=email,
        confirmed_at=datetime.now(UTC),
        auth0_sub=sub,
    )
    db.add(user)
    try:
        await db.flush()
        await add_user_to_default_league(db, user.id)
        await grant_default_role(db, user.id)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        winner = await resolve_linked_user(db, sub)
        if winner is not None:
            return winner
        return await _resolve_live_user_by_email(db, email)
    return user
