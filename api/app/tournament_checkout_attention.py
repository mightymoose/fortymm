"""Payer-scoped actionable checkout recovery projections."""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import TournamentCheckout
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
    rows = (
        await db.scalars(
            select(TournamentCheckout)
            .outerjoin(TournamentCheckout.payment)
            .where(
                TournamentCheckout.payer_account_id == payer_account_id,
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
        if payment is not None and payment.state not in _ACTIONABLE_STATES:
            continue
        if (payment is None or payment.state in _ACTIVE_STATES) and (
            _effective_state(checkout, checkout.tournament, now)
            is not TournamentCheckoutState.active
        ):
            continue
        kind = (
            _kind(payment.state)
            if payment is not None
            else CheckoutAttentionKind.active
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
