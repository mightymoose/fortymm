"""Payer-scoped actionable checkout recovery projections."""

import uuid
from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
    User,
)
from app.models.tournament_payment import TournamentPaymentState
from app.schemas.tournament_checkout import (
    CheckoutAttentionItem,
    CheckoutAttentionKind,
    TournamentCheckoutPaymentState,
    TournamentCheckoutState,
)
from app.tournament_checkouts import _database_now, _effective_state

_ACTIVE_STATES = {
    TournamentPaymentState.preparing,
    TournamentPaymentState.ready,
    TournamentPaymentState.action_required,
}
_ACTIONABLE_STATES = _ACTIVE_STATES | {
    TournamentPaymentState.checking,
    TournamentPaymentState.failed,
}


def _kind(state: TournamentPaymentState) -> CheckoutAttentionKind:
    if state is TournamentPaymentState.failed:
        return CheckoutAttentionKind.needs_review
    if state is TournamentPaymentState.checking:
        return CheckoutAttentionKind.checking
    return CheckoutAttentionKind.active


async def list_checkout_attention(
    db: AsyncSession, *, payer_account_id: uuid.UUID
) -> list[CheckoutAttentionItem]:
    """Return every actionable checkout in its stable user-facing priority."""
    now = await _database_now(db)
    # A payment remains owned by the account that created it for audit
    # purposes.  Resolve the caller's entire reverse merge chain solely as a
    # read projection so a second merge does not strand the original payer's
    # recovery UI.  UNION (rather than UNION ALL) also makes corrupt cycles
    # terminate without exposing unrelated accounts.
    payer_identities = (
        select(User.id)
        .where(User.id == payer_account_id)
        .cte("checkout_payer_identities", recursive=True)
    )
    payer_identities = payer_identities.union(
        select(User.id).join(
            payer_identities,
            User.merged_into_user_id == payer_identities.c.id,
        )
    )
    rows = (
        await db.scalars(
            select(TournamentCheckout)
            .join(Tournament, Tournament.id == TournamentCheckout.tournament_id)
            .join(
                payer_identities,
                payer_identities.c.id == TournamentCheckout.payer_account_id,
            )
            .outerjoin(TournamentCheckout.payment)
            .where(
                # Reverse-merge identities retain only recovery visibility.
                # A survivor must not inherit an old account's unsubmitted,
                # ready, or action-required payment capabilities.
                or_(
                    TournamentCheckout.payer_account_id == payer_account_id,
                    TournamentPayment.state.in_(
                        {
                            TournamentPaymentState.failed,
                            TournamentPaymentState.checking,
                        }
                    ),
                    TournamentPayment.provider_mismatch_at.is_not(None),
                ),
                or_(
                    TournamentPayment.provider_mismatch_at.is_not(None),
                    TournamentPayment.state.in_(
                        {
                            TournamentPaymentState.failed,
                            TournamentPaymentState.checking,
                        }
                    ),
                    and_(
                        or_(
                            TournamentPayment.id.is_(None),
                            TournamentPayment.state.in_(_ACTIVE_STATES),
                        ),
                        TournamentCheckout.status == TournamentCheckoutStatus.active,
                        TournamentCheckout.registration_generation
                        == Tournament.registration_generation,
                        TournamentCheckout.merchant_account_id
                        == Tournament.owner_account_id,
                        TournamentCheckout.expires_at > now,
                    ),
                ),
            )
            .options(
                selectinload(TournamentCheckout.tournament),
                selectinload(TournamentCheckout.payment),
            )
            .execution_options(populate_existing=True)
        )
    ).all()

    ranked: list[tuple[int, datetime, CheckoutAttentionItem]] = []
    for checkout in rows:
        payment = checkout.payment
        if (
            payment is not None
            and payment.state not in _ACTIONABLE_STATES
            and payment.provider_mismatch_at is None
        ):
            continue
        if (
            (payment is None or payment.state in _ACTIVE_STATES)
            and (payment is None or payment.provider_mismatch_at is None)
            and (
                _effective_state(checkout, checkout.tournament, now)
                is not TournamentCheckoutState.active
            )
        ):
            continue
        kind = CheckoutAttentionKind.active
        if payment is not None:
            kind = (
                CheckoutAttentionKind.needs_review
                if payment.provider_mismatch_at is not None
                else _kind(payment.state)
            )
        item = CheckoutAttentionItem(
            checkout_id=checkout.id,
            tournament_id=checkout.tournament_id,
            tournament_name=checkout.tournament.name,
            kind=kind,
            payment_state=(
                TournamentCheckoutPaymentState(payment.state.value)
                if payment is not None
                else TournamentCheckoutPaymentState.unavailable
            ),
            expires_at=checkout.expires_at,
            remaining_seconds=max(0, int((checkout.expires_at - now).total_seconds())),
            support_reference=(
                payment.support_reference if payment is not None else None
            ),
            href=(f"/tournaments/{checkout.tournament_id}/checkouts/{checkout.id}"),
        )
        priority = {
            CheckoutAttentionKind.needs_review: 0,
            CheckoutAttentionKind.checking: 1,
            CheckoutAttentionKind.active: 2,
        }[kind]
        ranked.append((priority, checkout.expires_at, item))

    ranked.sort(key=lambda row: (row[0], row[1], str(row[2].checkout_id)))
    return [item for _, _, item in ranked]
