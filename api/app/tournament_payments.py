"""Transport-neutral Stripe card-payment operations for a tournament checkout.

Three entry points — :func:`prepare_or_resume_payment` (create-or-resume,
the ONLY place the Stripe client secret is returned), :func:`read_payment_status`
(a status read) and the webhook route (``app.tournament_payment_routes``) —
ALL funnel through :func:`reconcile_payment`, the one function that validates a
PaymentIntent against the payment row, quarantines on any mismatch, and admits
each still-pending line exactly once (#1816). See ``api/CLAUDE.md``'s
service-layer conventions and the ticket's planning note for the full design.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
    TournamentPaymentLine,
    TournamentPaymentLineOutcome,
    TournamentPaymentProviderCreateState,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentPaymentStatus,
    User,
)
from app.payments.provider import (
    PaymentProvider,
    ProviderCreateUncertain,
    ProviderIntentCreated,
    ProviderPaymentIntent,
    ProviderRetrievalFailed,
)
from app.schemas.tournament_payment import (
    TournamentPaymentPrepared,
    TournamentPaymentRead,
)
from app.tournament_entries import admit_to_event
from app.tournament_errors import EntryRefusal, EntryRefusedError
from app.tournament_payment_errors import PaymentNotFoundError, PaymentNotReadyError
from app.tournament_payment_state import (
    TERMINAL_PAYMENT_STATUSES,
    payment_display_state,
)

#: An allowlist of safe, player-facing decline codes — never Stripe's raw
#: ``decline_code``/``message`` (#1816's player-facing-errors constraint).
_SAFE_ERROR_CODES = frozenset(
    {
        "card_declined",
        "expired_card",
        "incorrect_cvc",
        "incorrect_number",
        "insufficient_funds",
        "processing_error",
    }
)


def _safe_error_code(raw_code: str | None) -> str | None:
    if raw_code is None:
        return None
    return raw_code if raw_code in _SAFE_ERROR_CODES else "card_error"


def _key_is_live(secret_key: str) -> bool:
    return secret_key.startswith("sk_live_")


#: The six event types #1816 acts on. Every other type is still persisted and
#: acknowledged (evidence trail), then ignored — never rejected.
HANDLED_PROVIDER_EVENT_TYPES = frozenset(
    {
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "payment_intent.processing",
        "payment_intent.requires_action",
        "payment_intent.canceled",
        "charge.refunded",
    }
)


class IncomingProviderEvent(BaseModel):
    """The handful of webhook fields reconcile needs to route and pre-check —
    parsed once at the webhook boundary (``app.tournament_payment_routes``)
    from ``stripe.Event.to_dict()``. Deliberately NOT the full PaymentIntent:
    reconcile always re-retrieves that itself, so quarantine's captured amount
    (and every other validated field) comes from Fortymm's own retrieval, never
    from the webhook payload (#1816 constraint)."""

    id: str
    type: str
    livemode: bool
    account: str | None = None
    #: The PaymentIntent id this event is about — ``data.object.id`` for a
    #: ``payment_intent.*`` event, or ``data.object.payment_intent`` for a
    #: ``charge.refunded`` event (whose ``data.object.id`` is a CHARGE id).
    payment_intent_id: str | None = None


def parse_incoming_provider_event(raw: dict[str, Any]) -> IncomingProviderEvent:
    data = raw.get("data")
    data_object = data.get("object", {}) if isinstance(data, dict) else {}
    event_type = raw["type"]
    if event_type == "charge.refunded":
        payment_intent_id = (
            data_object.get("payment_intent") if isinstance(data_object, dict) else None
        )
    else:
        payment_intent_id = (
            data_object.get("id") if isinstance(data_object, dict) else None
        )
    return IncomingProviderEvent(
        id=raw["id"],
        type=event_type,
        livemode=raw["livemode"],
        account=raw.get("account"),
        payment_intent_id=(
            payment_intent_id if isinstance(payment_intent_id, str) else None
        ),
    )


async def find_payment_id_for_provider_event(
    db: AsyncSession, event: IncomingProviderEvent
) -> uuid.UUID | None:
    """Resolve which payment row an incoming event is about, by the
    PaymentIntent id Fortymm itself stored — never by trusting the webhook's
    own metadata for routing (reconcile re-validates metadata separately,
    against the RETRIEVED intent)."""
    if event.payment_intent_id is None:
        return None
    return await db.scalar(
        select(TournamentPayment.id).where(
            TournamentPayment.provider_payment_intent_id == event.payment_intent_id
        )
    )


async def _database_now(db: AsyncSession) -> datetime:
    now: datetime = (await db.execute(select(func.clock_timestamp()))).scalar_one()
    return now if now.tzinfo is not None else now.replace(tzinfo=UTC)


def _map_provider_status(
    provider_status: str, *, current: TournamentPaymentStatus
) -> TournamentPaymentStatus:
    """Stripe's raw PaymentIntent status, mapped to Fortymm's own — used for
    every status EXCEPT ``succeeded`` (which only ``_admit`` sets, after this
    module's own validation, never a bare copy of Stripe's word)."""
    if current is TournamentPaymentStatus.cancel_requested:
        # The director's cancel is authoritative; a non-terminal Stripe status
        # must not un-flag it (only an actual ``canceled`` — handled by the
        # caller — or ``succeeded`` — handled by ``_admit`` — may move it on).
        return current
    match provider_status:
        case "requires_payment_method" | "requires_confirmation":
            return TournamentPaymentStatus.ready
        case "requires_action":
            return TournamentPaymentStatus.action_required
        case "processing" | "requires_capture":
            return TournamentPaymentStatus.checking
        case "canceled":
            return TournamentPaymentStatus.canceled
        case _:
            return current


def _checkout_is_dead(
    checkout: TournamentCheckout, tournament: Tournament, now: datetime
) -> bool:
    """Whether this checkout can no longer be completed by a NEW attempt —
    mirrors ``app.tournament_checkouts.checkout_effective_state``'s non-active
    branches, inlined to avoid a cross-module import cycle (that module calls
    back into payment status for its own read). Used only to decide the
    ``expired`` DISPLAY state; it never blocks a late success from admitting
    (#1816: expiry alone does not forfeit an otherwise-valid entry)."""
    if checkout.status is not TournamentCheckoutStatus.active:
        return True
    if checkout.registration_generation != tournament.registration_generation:
        return True
    if checkout.merchant_account_id != tournament.owner_account_id:
        return True
    return checkout.expires_at <= now


async def _load_checkout_for_payer(
    db: AsyncSession, *, tournament_id: uuid.UUID, checkout_id: uuid.UUID, actor: User
) -> TournamentCheckout:
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
        .options(selectinload(TournamentCheckout.lines))
    )
    if checkout is None or checkout.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    return checkout


def _can_view_payment(payment: TournamentPayment, actor: User) -> bool:
    merchant_account_id = get_settings().tournament_payment_merchant_account_id
    return payment.payer_account_id == actor.id or (
        merchant_account_id is not None and merchant_account_id == actor.id
    )


def _to_read_schema(payment: TournamentPayment) -> TournamentPaymentRead:
    return TournamentPaymentRead(
        id=payment.id,
        checkout_id=payment.checkout_id,
        reference=payment.reference,
        status=payment_display_state(payment.status),
        last_error=payment.last_error_code,
        amount_cents=payment.amount_cents,
        currency=payment.currency,
        created_at=payment.created_at,
    )


async def prepare_or_resume_payment(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
) -> TournamentPaymentPrepared:
    """Create the checkout's PaymentIntent, or resume it if one already
    exists. The ONLY operation that returns the Stripe client secret."""
    checkout = await _load_checkout_for_payer(
        db, tournament_id=tournament_id, checkout_id=checkout_id, actor=actor
    )
    if checkout.status is not TournamentCheckoutStatus.active:
        raise PaymentNotReadyError()

    payment = await db.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout.id)
    )
    if payment is None:
        merchant_account_id = get_settings().tournament_payment_merchant_account_id
        if merchant_account_id is None:
            raise PaymentNotReadyError()
        payment = TournamentPayment(
            checkout_id=checkout.id,
            payer_account_id=actor.id,
            tournament_id=tournament_id,
            payee_stripe_account=None,
            payee_fortymm_account_id=merchant_account_id,
            idempotency_key=f"tournament-payment:{checkout.id}",
            amount_cents=checkout.total_cents,
            currency=checkout.currency,
            provider_create_state=TournamentPaymentProviderCreateState.committed,
            lines=[
                TournamentPaymentLine(
                    event_id=line.event_id, price_cents=line.price_cents
                )
                for line in checkout.lines
            ],
        )
        db.add(payment)
        # The provider-create OBLIGATION is durable before any Stripe call
        # (#1816) — committed here, outside any lock, before the network call
        # below.
        await db.commit()

    client_secret: str | None = None
    locked = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment.id)
        .with_for_update()
        .options(selectinload(TournamentPayment.lines))
    )
    assert locked is not None
    payment = locked
    if payment.payer_account_id != actor.id:
        raise PaymentNotFoundError()

    if (
        payment.provider_create_state
        is not TournamentPaymentProviderCreateState.created
    ):
        outcome = await provider.create_payment_intent(
            payee_account=payment.payee_stripe_account,
            amount_cents=payment.amount_cents,
            currency=payment.currency.lower(),
            idempotency_key=payment.idempotency_key,
            metadata={"payment_id": str(payment.id)},
            statement_descriptor_suffix=f"FORTYMM{len(payment.lines)}",
        )
        match outcome:
            case ProviderIntentCreated(intent=intent):
                payment.provider_create_state = (
                    TournamentPaymentProviderCreateState.created
                )
                payment.provider_payment_intent_id = intent.id
                payment.status = _map_provider_status(
                    intent.status, current=payment.status
                )
                client_secret = intent.client_secret
            case ProviderCreateUncertain():
                payment.status = TournamentPaymentStatus.preparing
        await db.commit()
    else:
        await db.commit()  # release the lock before the network round trip
        reconciled = await reconcile_payment(
            db, payment_id=payment.id, provider=provider
        )
        if reconciled is not None:
            payment = reconciled
        if payment.provider_payment_intent_id is not None:
            try:
                intent = await provider.retrieve_payment_intent(
                    payee_account=payment.payee_stripe_account,
                    payment_intent_id=payment.provider_payment_intent_id,
                )
                client_secret = intent.client_secret
            except ProviderRetrievalFailed:
                client_secret = None

    return TournamentPaymentPrepared(
        **_to_read_schema(payment).model_dump(), client_secret=client_secret
    )


async def read_payment_status(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
) -> TournamentPaymentRead:
    checkout = await db.scalar(
        select(TournamentCheckout).where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
    )
    if checkout is None:
        raise PaymentNotFoundError()
    payment = await db.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout.id)
    )
    if payment is None or not _can_view_payment(payment, actor):
        raise PaymentNotFoundError()

    if (
        payment.status not in TERMINAL_PAYMENT_STATUSES
        and payment.provider_payment_intent_id is not None
    ):
        reconciled = await reconcile_payment(
            db, payment_id=payment.id, provider=provider
        )
        if reconciled is not None:
            payment = reconciled
    return _to_read_schema(payment)


async def _admit(
    db: AsyncSession, payment: TournamentPayment, intent: ProviderPaymentIntent
) -> None:
    """Convert each still-pending line into a registration exactly once, or a
    refund obligation when it cannot admit (#1816). Runs under the payment
    row's own lock; each ``admit_to_event`` call takes ITS OWN tournament lock
    (never held across the Stripe call above it)."""
    payer = await db.get(User, payment.payer_account_id)
    if payer is None:
        payment.status = TournamentPaymentStatus.quarantined
        payment.amount_unverified = True
        return
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == payment.checkout_id)
        .with_for_update()
    )
    if checkout is not None and checkout.status is TournamentCheckoutStatus.active:
        # Consume the hold: it must stop counting toward capacity once its
        # lines convert into real registrations, or capacity double-counts
        # the payer's own still-active checkout against itself (planning
        # note: "admission must transition the hold into a real registration,
        # not just add a registration alongside a still-counted hold"). No
        # checkout status exists for "fulfilled" — ``cancelled`` already
        # means exactly "this checkout no longer reserves capacity", which is
        # true here, and this checkout's own history is superseded by the
        # payment's.
        checkout.status = TournamentCheckoutStatus.cancelled
    for line in payment.lines:
        if line.outcome is not TournamentPaymentLineOutcome.pending:
            continue
        try:
            entrant = await admit_to_event(
                db,
                tournament_id=payment.tournament_id,
                event_id=line.event_id,
                actor=payer,
                user_id=None,
                client_ip=None,
                payment_authorized=True,
            )
        except EntryRefusedError as refusal:
            line.outcome = TournamentPaymentLineOutcome.refund_due
            reason = (
                TournamentPaymentRefundReason.superseded_by_director_entry
                if refusal.refusal is EntryRefusal.already_entered
                else TournamentPaymentRefundReason.line_could_not_admit
            )
            db.add(
                TournamentPaymentRefundObligation(
                    payment_id=payment.id,
                    event_id=line.event_id,
                    amount_cents=line.price_cents,
                    reason=reason,
                )
            )
        else:
            line.outcome = TournamentPaymentLineOutcome.admitted
            line.entry_id = entrant.id
    payment.status = TournamentPaymentStatus.succeeded


async def _quarantine(
    db: AsyncSession,
    payment: TournamentPayment,
    *,
    obligation_amount_cents: int | None,
    amount_unverified: bool,
) -> None:
    payment.status = TournamentPaymentStatus.quarantined
    payment.amount_unverified = amount_unverified
    if obligation_amount_cents and obligation_amount_cents > 0:
        db.add(
            TournamentPaymentRefundObligation(
                payment_id=payment.id,
                event_id=None,
                amount_cents=obligation_amount_cents,
                reason=TournamentPaymentRefundReason.quarantine,
            )
        )


async def reconcile_payment(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    provider: PaymentProvider,
    source_event: IncomingProviderEvent | None = None,
) -> TournamentPayment | None:
    """The one function webhooks, the status read, and prepare/resume ALL
    call — validation, quarantine-on-failure, and admission-on-success live
    here exactly once, which is what makes exactly-once provable (#1816).

    Locks the payment row first (serializing a webhook racing a status read
    for the same success), retrieves the PaymentIntent with Fortymm's own key
    (never trusting ``source_event``'s payload for anything but routing/cheap
    pre-checks), validates it, and either quarantines or admits.
    """
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .with_for_update()
        .options(selectinload(TournamentPayment.lines))
    )
    if payment is None:
        return None
    if payment.status in TERMINAL_PAYMENT_STATUSES:
        return payment
    if payment.provider_payment_intent_id is None:
        return payment

    settings = get_settings()
    try:
        intent = await provider.retrieve_payment_intent(
            payee_account=payment.payee_stripe_account,
            payment_intent_id=payment.provider_payment_intent_id,
        )
    except ProviderRetrievalFailed:
        await _quarantine(
            db, payment, obligation_amount_cents=None, amount_unverified=True
        )
        await db.commit()
        return payment

    key_is_live = _key_is_live(settings.stripe_secret_key)
    event_account_ok = (
        source_event is None or source_event.account == payment.payee_stripe_account
    )
    identity_ok = (
        intent.id == payment.provider_payment_intent_id
        and intent.livemode == key_is_live
        and intent.amount == payment.amount_cents
        and intent.currency.upper() == payment.currency
        and intent.metadata_payment_id == str(payment.id)
    )
    if not identity_ok or not event_account_ok:
        await _quarantine(
            db,
            payment,
            obligation_amount_cents=intent.amount_received,
            amount_unverified=False,
        )
        await db.commit()
        return payment

    if source_event is not None and source_event.type == "charge.refunded":
        # Evidence-only (#1816): adds to the trail, changes no obligation.
        await db.commit()
        return payment

    if intent.status == "succeeded":
        await _admit(db, payment, intent)
    elif intent.status == "canceled":
        payment.status = TournamentPaymentStatus.canceled
    else:
        payment.status = _map_provider_status(intent.status, current=payment.status)
        if intent.status in ("requires_payment_method", "requires_confirmation"):
            payment.last_error_code = _safe_error_code(intent.last_payment_error_code)
        checkout = await db.get(TournamentCheckout, payment.checkout_id)
        tournament = await db.get(Tournament, payment.tournament_id)
        if (
            checkout is not None
            and tournament is not None
            and payment.status
            in (
                TournamentPaymentStatus.ready,
                TournamentPaymentStatus.checking,
                TournamentPaymentStatus.action_required,
            )
            and _checkout_is_dead(checkout, tournament, await _database_now(db))
        ):
            payment.status = TournamentPaymentStatus.expired
    await db.commit()
    return payment
