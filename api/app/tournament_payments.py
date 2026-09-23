"""Prepare and resume the single durable payment for a tournament checkout."""

import uuid
from typing import assert_never

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.account_merge_resolution import (
    is_terminal_merge_survivor,
    terminal_active_account_id,
)
from app.config import get_settings
from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
    TournamentPaymentAllocation,
    TournamentPaymentState,
    User,
)
from app.notifications.service import enqueue_notification_job
from app.notifications.taxonomy import NotificationCategory
from app.payment_provider import (
    STRIPE_USD_MAX_AMOUNT_CENTS,
    PaymentIntentCreate,
    PaymentProvider,
    PaymentProviderAmountInvalidError,
    PaymentProviderCreateRejectedError,
    PaymentProviderNotFoundError,
    PaymentProviderReceiptUpdateRejectedError,
    PaymentProviderUncertainError,
    ProviderPaymentIntent,
    ProviderPaymentStatus,
)
from app.payment_support_reference import payment_support_reference
from app.rbac import user_has_permission
from app.realtime import EventKind, stage_event
from app.schemas.notification import NotificationJob
from app.schemas.tournament_checkout import (
    TournamentCheckoutPaymentState,
    TournamentPaymentLineOutcomeState,
    TournamentPaymentLineRead,
    TournamentPaymentRead,
)
from app.tournament_checkouts import _database_now
from app.tournament_registration import registration_open

PAYMENTS_VIEW_PERMISSION = "payments.view"
TERMINAL_PAYMENT_STATES = frozenset(
    {
        TournamentPaymentState.failed,
        TournamentPaymentState.canceled,
        TournamentPaymentState.succeeded,
    }
)
MAX_RECEIPT_SYNC_ATTEMPTS = 5
IN_FLIGHT_CREATE_PROVIDER_STATUS = "create_in_flight"
UNCERTAIN_CREATE_PROVIDER_STATUS = "create_uncertain"


class PaymentNotFoundError(Exception):
    pass


class PaymentCollectionDisabledError(Exception):
    pass


class PaymentAmountInvalidError(Exception):
    pass


class PaymentCreateRejectedError(Exception):
    pass


def _is_durable_payment_history(payment: TournamentPayment) -> bool:
    return payment.state in TERMINAL_PAYMENT_STATES or (
        payment.state is TournamentPaymentState.expired
        and payment.provider_payment_id is None
    )


def public_payment_state(
    provider_status: ProviderPaymentStatus,
) -> TournamentPaymentState:
    match provider_status:
        case (
            ProviderPaymentStatus.requires_payment_method
            | ProviderPaymentStatus.requires_confirmation
        ):
            return TournamentPaymentState.ready
        case ProviderPaymentStatus.requires_action:
            return TournamentPaymentState.action_required
        case (
            ProviderPaymentStatus.processing
            | ProviderPaymentStatus.requires_capture
            | ProviderPaymentStatus.succeeded
        ):
            # Success must pass invariant validation and admission reconciliation
            # before the aggregate becomes terminal.
            return TournamentPaymentState.checking
        case ProviderPaymentStatus.canceled:
            return TournamentPaymentState.canceled
    assert_never(provider_status)


def payment_intent_create_request(
    payment: TournamentPayment, checkout: TournamentCheckout
) -> PaymentIntentCreate:
    """Rebuild the provider create command from the durable obligation."""
    return PaymentIntentCreate(
        amount_cents=payment.amount_cents,
        currency=payment.currency,
        merchant_account_id=str(checkout.merchant_account_id),
        payment_method_types=["card"],
        save_payment_method=False,
        idempotency_key=payment.durable_identity,
        receipt_email=payment.receipt_email,
    )


def _new_payment_obligation(
    checkout: TournamentCheckout,
    *,
    receipt_email: str | None,
    state: TournamentPaymentState = TournamentPaymentState.preparing,
    provider_status: str | None = None,
) -> TournamentPayment:
    """Build the one durable payment projection from an immutable checkout."""
    return TournamentPayment(
        checkout_id=checkout.id,
        durable_identity=f"fortymm:checkout:{checkout.id}:payment:v1",
        receipt_email=receipt_email,
        currency=checkout.currency,
        amount_cents=checkout.total_cents,
        state=state,
        provider_status=provider_status,
        allocations=[
            TournamentPaymentAllocation(
                checkout_line_id=line.id,
                checkout_id=checkout.id,
                amount_cents=line.price_cents,
            )
            for line in checkout.lines
        ],
    )


async def _persist_preprovider_cancellation(
    db: AsyncSession,
    checkout: TournamentCheckout,
    *,
    provider_status: str,
) -> TournamentPayment:
    """Keep a readable terminal projection when no provider create is possible."""
    payment = checkout.payment
    if payment is None:
        payment = _new_payment_obligation(
            checkout,
            receipt_email=None,
            state=TournamentPaymentState.canceled,
            provider_status=provider_status,
        )
        db.add(payment)
    now = await _database_now(db)
    checkout.status = TournamentCheckoutStatus.cancelled
    checkout.cancelled_at = checkout.cancelled_at or now
    payment.state = TournamentPaymentState.canceled
    payment.updated_at = now
    stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
    await db.commit()
    return payment


def _read(
    payment: TournamentPayment,
    *,
    include_client_secret: bool = True,
    receipt_editable: bool = True,
) -> TournamentPaymentRead:
    event_ids = {line.id: line.event_id for line in payment.checkout.lines}
    return TournamentPaymentRead(
        checkout_id=payment.checkout_id,
        payment_state=TournamentCheckoutPaymentState(payment.state.value),
        client_secret=(
            payment.client_secret
            if include_client_secret and not _is_durable_payment_history(payment)
            else None
        ),
        receipt_email=payment.receipt_email,
        receipt_editable=receipt_editable,
        support_reference=payment.support_reference,
        lines=[
            TournamentPaymentLineRead(
                event_id=event_ids[allocation.checkout_line_id],
                amount_cents=allocation.amount_cents,
                outcome=(
                    TournamentPaymentLineOutcomeState(allocation.outcome.value)
                    if allocation.outcome
                    else None
                ),
                refund_amount_cents=allocation.refund_amount_cents,
            )
            for allocation in payment.allocations
        ],
    )


def _read_unavailable_checkout(checkout: TournamentCheckout) -> TournamentPaymentRead:
    """Project an authorized checkout without creating a payment obligation."""
    return TournamentPaymentRead(
        checkout_id=checkout.id,
        payment_state=TournamentCheckoutPaymentState.unavailable,
        client_secret=None,
        receipt_email=None,
        receipt_editable=False,
        support_reference=None,
        lines=[
            TournamentPaymentLineRead(
                event_id=line.event_id,
                amount_cents=line.price_cents,
                outcome=None,
                refund_amount_cents=0,
            )
            for line in checkout.lines
        ],
    )


async def _load(
    db: AsyncSession, tournament_id: uuid.UUID, checkout_id: uuid.UUID
) -> TournamentCheckout | None:
    checkout: TournamentCheckout | None = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
        .options(
            selectinload(TournamentCheckout.lines),
            selectinload(TournamentCheckout.tournament),
            selectinload(TournamentCheckout.payment),
            selectinload(TournamentCheckout.payment).selectinload(
                TournamentPayment.allocations
            ),
        )
        .execution_options(populate_existing=True)
    )
    return checkout


async def _load_for_first_obligation_locked(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    payer_account_id: uuid.UUID,
) -> TournamentCheckout:
    """Reload a first-payment candidate under the registration lock order."""
    payer = await db.scalar(
        select(User)
        .where(User.id == payer_account_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    if payer is None or not payer.is_active or payer.merged_into_user_id is not None:
        raise PaymentNotFoundError()
    tournament = await db.scalar(
        select(Tournament)
        .where(Tournament.id == tournament_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if tournament is None:
        raise PaymentNotFoundError()
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
            TournamentCheckout.payer_account_id == payer_account_id,
        )
        .options(
            selectinload(TournamentCheckout.lines),
            selectinload(TournamentCheckout.tournament),
            selectinload(TournamentCheckout.payment),
            selectinload(TournamentCheckout.payment).selectinload(
                TournamentPayment.allocations
            ),
        )
        .with_for_update(of=TournamentCheckout)
        .execution_options(populate_existing=True)
    )
    if checkout is None:
        raise PaymentNotFoundError()
    return checkout


async def _terminalize_stale_checkout(
    db: AsyncSession,
    checkout: TournamentCheckout,
    payment: TournamentPayment | None = None,
) -> bool:
    """Release stale authority and its unbound payment obligation, if any."""
    now = await _database_now(db)
    changed = False
    if checkout.status is TournamentCheckoutStatus.active:
        if checkout.expires_at <= now:
            checkout.status = TournamentCheckoutStatus.expired
            changed = True
        elif (
            checkout.registration_generation
            != checkout.tournament.registration_generation
            or checkout.merchant_account_id != checkout.tournament.owner_account_id
            or not registration_open(checkout.tournament)
        ):
            checkout.status = TournamentCheckoutStatus.invalidated
            changed = True
    if checkout.status is not TournamentCheckoutStatus.active:
        if payment is not None:
            terminal_payment_state = (
                TournamentPaymentState.expired
                if checkout.status is TournamentCheckoutStatus.expired
                else TournamentPaymentState.canceled
            )
            if payment.state is not terminal_payment_state:
                payment.state = terminal_payment_state
                payment.updated_at = now
                changed = True
        if changed:
            stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
        await db.commit()
        return True
    return False


async def _checkout_has_payment_authority(
    db: AsyncSession, checkout: TournamentCheckout
) -> bool:
    """Return whether payer-facing operations remain authorized right now."""
    return (
        checkout.status is TournamentCheckoutStatus.active
        and checkout.expires_at > await _database_now(db)
        and checkout.registration_generation
        == checkout.tournament.registration_generation
        and checkout.merchant_account_id == checkout.tournament.owner_account_id
        and registration_open(checkout.tournament)
    )


async def provider_create_request_if_authorized(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    payer_account_id: uuid.UUID,
    payment_id: uuid.UUID,
) -> PaymentIntentCreate | None:
    """Revalidate an unbound obligation under locks, releasing them before I/O."""
    checkout = await _load_for_first_obligation_locked(
        db,
        tournament_id=tournament_id,
        checkout_id=checkout_id,
        payer_account_id=payer_account_id,
    )
    payment = checkout.payment
    if payment is None or payment.id != payment_id:
        await db.rollback()
        raise PaymentNotFoundError()
    if payment.provider_payment_id is not None:
        await db.commit()
        return None
    if payment.provider_mismatch_at is not None:
        # Foreign or invariant-breaking evidence is not proof of absence and
        # cannot authorize another create. Preserve the durable quarantine.
        await db.commit()
        return None
    # A timed-out create may already exist remotely. Close stale payer-facing
    # authority, but retain the unbound recovery obligation until provider
    # evidence proves whether the idempotent create was accepted.
    stale_payment = (
        None if payment.provider_status == UNCERTAIN_CREATE_PROVIDER_STATUS else payment
    )
    if await _terminalize_stale_checkout(db, checkout, stale_payment):
        return None
    request = payment_intent_create_request(payment, checkout)
    # Crossing the provider boundary creates a recovery obligation of its own:
    # the process can disappear after Stripe accepts the idempotent create but
    # before we receive (or persist) its response.  Commit that fact while the
    # checkout is still locked and authorized.  A concurrent expiry may hide
    # the payer capability, but the sweep can still find this marker and adopt
    # or refund any provider object that was created.
    payment.provider_status = IN_FLIGHT_CREATE_PROVIDER_STATUS
    payment.updated_at = await _database_now(db)
    # Provider I/O must not retain Account, Tournament, or Checkout locks.
    await db.commit()
    return request


async def _store_provider_result(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    intent: ProviderPaymentIntent,
) -> TournamentPayment:
    # A provider response is not safe to persist piecemeal. Reconciliation
    # validates both an existing binding and every immutable association field
    # for an uncertain create before it adopts the id, status, or secret.
    from app.tournament_payment_reconciliation import reconcile_provider_intent

    try:
        payment = await reconcile_provider_intent(
            db, payment_id=payment_id, intent=intent
        )
    except LookupError as error:
        raise PaymentNotFoundError() from error
    await db.commit()
    return payment


async def _revalidate_bound_payment_authority(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    payer_account_id: uuid.UUID,
    payment_id: uuid.UUID,
) -> TournamentPayment:
    """Recheck payer-facing authority after provider I/O has bound an intent."""
    checkout = await _load_for_first_obligation_locked(
        db,
        tournament_id=tournament_id,
        checkout_id=checkout_id,
        payer_account_id=payer_account_id,
    )
    payment = checkout.payment
    if (
        payment is None
        or payment.id != payment_id
        or payment.provider_payment_id is None
    ):
        await db.rollback()
        raise PaymentNotFoundError()
    # Terminal evidence may itself consume or invalidate the checkout while
    # provider I/O is in flight. It is safe immutable history, not a reusable
    # payer capability, and should be returned redacted rather than converted
    # into a misleading not-found response.
    if _is_durable_payment_history(payment):
        await db.commit()
        return payment
    has_payment_authority = await _checkout_has_payment_authority(db, checkout)
    # A bound intent remains remotely mutable and must stay sweepable. Losing
    # payer-facing authority therefore hides its secret without terminalizing
    # the durable aggregate.
    await db.commit()
    if not has_payment_authority:
        raise PaymentNotFoundError()
    return payment


async def reload_payment_after_provider_io_locked(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    payer_account_id: uuid.UUID,
    payment_id: uuid.UUID,
) -> TournamentPayment:
    """Reload a payment under the registration lock order after provider I/O."""
    await _load_for_first_obligation_locked(
        db,
        tournament_id=tournament_id,
        checkout_id=checkout_id,
        payer_account_id=payer_account_id,
    )
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .options(
            selectinload(TournamentPayment.allocations),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.lines
            ),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.tournament
            ),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payment is None or payment.checkout_id != checkout_id:
        await db.rollback()
        raise PaymentNotFoundError()
    return payment


async def _reload_payment_for_create_rejection_locked(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    payer_account_id: uuid.UUID,
    payment_id: uuid.UUID,
) -> TournamentPayment:
    """Reload an unbound create obligation solely to terminalize rejection.

    A same-person account merge may commit while provider create is in flight.
    The ordinary reload correctly rejects that historical actor because it is
    used by provider-mutating paths.  A permanent provider refusal is different:
    it must close the already-created obligation and checkout even after the
    payer becomes historical, while retaining their ids as audit ownership.
    """
    payer = await db.scalar(
        select(User)
        .where(User.id == payer_account_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    if payer is None:
        raise PaymentNotFoundError()
    tournament = await db.scalar(
        select(Tournament)
        .where(Tournament.id == tournament_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if tournament is None:
        raise PaymentNotFoundError()
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
            TournamentCheckout.payer_account_id == payer_account_id,
        )
        .with_for_update(of=TournamentCheckout)
        .execution_options(populate_existing=True)
    )
    if checkout is None:
        raise PaymentNotFoundError()
    payment = await db.scalar(
        select(TournamentPayment)
        .where(
            TournamentPayment.id == payment_id,
            TournamentPayment.checkout_id == checkout_id,
        )
        .options(
            selectinload(TournamentPayment.allocations),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.lines
            ),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.tournament
            ),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payment is None:
        await db.rollback()
        raise PaymentNotFoundError()
    return payment


async def reload_payment_for_reconciliation_locked(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    payer_account_id: uuid.UUID,
    payment_id: uuid.UUID,
) -> tuple[TournamentPayment, User | None]:
    """Reload recovery state without treating payer authority as existence.

    Reconciliation owns provider obligations after a payer is deactivated,
    erased, or merged. It still follows the registration lock order, but unlike
    payer-facing reloads it must not reject the durable payment merely because
    that account can no longer act.
    """
    payer = await db.scalar(
        select(User)
        .where(User.id == payer_account_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    tournament = await db.scalar(
        select(Tournament)
        .where(Tournament.id == tournament_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if tournament is None:
        await db.rollback()
        raise PaymentNotFoundError()
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
            TournamentCheckout.payer_account_id == payer_account_id,
        )
        .with_for_update(of=TournamentCheckout)
        .execution_options(populate_existing=True)
    )
    if checkout is None:
        await db.rollback()
        raise PaymentNotFoundError()
    payment = await db.scalar(
        select(TournamentPayment)
        .where(
            TournamentPayment.id == payment_id,
            TournamentPayment.checkout_id == checkout_id,
        )
        .options(
            selectinload(TournamentPayment.allocations),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.lines
            ),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.tournament
            ),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payment is None:
        await db.rollback()
        raise PaymentNotFoundError()
    return payment, payer


async def _sync_provider_receipt(
    db: AsyncSession,
    *,
    provider: PaymentProvider,
    payment_id: uuid.UUID,
    provider_payment_id: str,
    attempted_email: str | None,
) -> TournamentPayment:
    """Converge provider receipt state after concurrent desired-email edits."""
    payment: TournamentPayment | None = None
    for _attempt in range(MAX_RECEIPT_SYNC_ATTEMPTS):
        # The desired value and the obligation to copy it are one durable local
        # fact. Commit that fact before provider I/O so timeout/worker death can
        # never lose an edit that may or may not have reached the provider.
        payment = await db.scalar(
            select(TournamentPayment)
            .where(TournamentPayment.id == payment_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if payment is None:
            raise PaymentNotFoundError()
        attempted_email = payment.receipt_email
        payment.receipt_sync_pending = True
        payment.updated_at = await _database_now(db)
        await db.commit()
        try:
            intent = await provider.update_payment_intent_receipt(
                provider_payment_id, attempted_email
            )
        except (TimeoutError, PaymentProviderUncertainError):
            # The desired email was committed before provider I/O. Preserve it
            # and return a usable response; a later explicit prepare retries
            # convergence without guessing whether this update landed.
            current_payment = await db.get(TournamentPayment, payment_id)
            if current_payment is None:
                raise PaymentNotFoundError() from None
            return current_payment
        except PaymentProviderReceiptUpdateRejectedError:
            # Canceled intents cannot always be mutated to clear provider-held
            # receipt PII. This is terminal provider work, not a retryable
            # sweep obligation: preserve a manual-review fact and continue.
            payment = await db.scalar(
                select(TournamentPayment)
                .where(TournamentPayment.id == payment_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if payment is None:
                raise PaymentNotFoundError() from None
            if (
                payment.receipt_email != attempted_email
                or payment.provider_payment_id != provider_payment_id
            ):
                # This rejection belongs to an older desired value or provider
                # binding.  A concurrent writer owns the current sync marker;
                # never terminalize its still-unresolved obligation.
                await db.commit()
                return payment
            payment.receipt_sync_pending = False
            payment.receipt_sync_failed_at = await _database_now(db)
            payment.support_reference = (
                payment.support_reference or payment_support_reference(payment.id)
            )
            payment.updated_at = payment.receipt_sync_failed_at
            await db.commit()
            return payment
        payment = await _store_provider_result(db, payment_id=payment_id, intent=intent)

        # Only a successful provider response for the current desired value can
        # discharge the marker. Serialize this comparison with receipt edits so
        # an older request cannot clear a newer writer's obligation.
        payment = await db.scalar(
            select(TournamentPayment)
            .where(TournamentPayment.id == payment_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if payment is None:
            raise PaymentNotFoundError()
        if (
            intent.id != provider_payment_id
            or payment.provider_payment_id != provider_payment_id
        ):
            # An anomalous response was quarantined by reconciliation. It is
            # not confirmation that this payment's receipt setting changed.
            await db.commit()
            return payment
        if payment.receipt_email == attempted_email:
            payment.receipt_sync_pending = False
            payment.receipt_sync_failed_at = None
            payment.updated_at = await _database_now(db)
            await db.commit()
            return payment
        await db.commit()
        attempted_email = payment.receipt_email
    # Continuous writers can prevent convergence. The newest desired value is
    # already durable, so return it and let a later prepare safely retry the
    # provider update instead of pinning this request in an unbounded loop.
    if payment is None:
        raise PaymentNotFoundError()
    await db.refresh(payment, attribute_names=["receipt_email", "receipt_sync_pending"])
    return payment


async def prepare_payment(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
    receipt_email: str | None,
    receipt_email_supplied: bool,
) -> TournamentPaymentRead:
    """Persist provider intent before I/O, then create or recover it idempotently."""
    checkout = await _load(db, tournament_id, checkout_id)
    if checkout is None or checkout.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    if (
        checkout.payment is None
        and checkout.currency.upper() == "USD"
        and checkout.total_cents > STRIPE_USD_MAX_AMOUNT_CENTS
    ):
        # Reject impossible aggregates before creating a durable provider
        # obligation. The same decision must release the checkout's holds;
        # otherwise every retry can only repeat this permanent refusal.
        checkout = await _load_for_first_obligation_locked(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            payer_account_id=actor.id,
        )
        await _persist_preprovider_cancellation(
            db, checkout, provider_status="amount_not_supported"
        )
        raise PaymentAmountInvalidError()

    payment = checkout.payment
    created_obligation = False
    if payment is None:
        checkout = await _load_for_first_obligation_locked(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            payer_account_id=actor.id,
        )
        payment = checkout.payment
        if payment is not None:
            # A concurrent first request won while this request waited. Resume
            # its durable aggregate without carrying registration locks into
            # any provider call below.
            await db.commit()
    if payment is None:
        if await _terminalize_stale_checkout(db, checkout):
            raise PaymentNotFoundError()
        if not get_settings().tournament_payment_collection_enabled:
            await _persist_preprovider_cancellation(
                db, checkout, provider_status="collection_disabled"
            )
            raise PaymentCollectionDisabledError()
        payer = await db.get(User, checkout.payer_account_id)
        if payer is None:
            raise PaymentNotFoundError()
        selected_email = receipt_email if receipt_email_supplied else None
        if not receipt_email_supplied and payer.confirmed_at is not None:
            selected_email = payer.email
        payment = _new_payment_obligation(checkout, receipt_email=selected_email)
        db.add(payment)
        try:
            # This commit is the create obligation. No tournament/capacity lock is
            # held while the external processor is called below.
            stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
            await db.commit()
            created_obligation = True
        except IntegrityError:
            await db.rollback()
            checkout = await _load(db, tournament_id, checkout_id)
            if checkout is None or checkout.payment is None:
                raise
            payment = checkout.payment

    # Terminal aggregates are durable history. A later prepare is a safe read,
    # never permission to disclose a reusable secret or mutate provider/local
    # receipt state.
    if _is_durable_payment_history(payment):
        return _read(payment, include_client_secret=False)

    if not created_obligation:
        # Revalidate every existing aggregate under the same lock order as
        # registration. The commit releases those locks before provider I/O.
        checkout = await _load_for_first_obligation_locked(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            payer_account_id=actor.id,
        )
        payment = checkout.payment
        if payment is None:
            await db.rollback()
            raise PaymentNotFoundError()
        if _is_durable_payment_history(payment):
            await db.commit()
            return _read(payment, include_client_secret=False)
        has_payment_authority = await _checkout_has_payment_authority(db, checkout)
        if not has_payment_authority:
            # A bound provider intent remains nonterminal so the reconciliation
            # sweep can observe a later capture and create refund obligations.
            if payment.provider_payment_id is None:
                if (
                    payment.provider_status == UNCERTAIN_CREATE_PROVIDER_STATUS
                    or payment.provider_mismatch_at is not None
                ):
                    # A timed-out create may exist remotely. Expire the payer
                    # capability while preserving the recovery obligation so
                    # the sweep can discover late success and refund it.
                    await _terminalize_stale_checkout(db, checkout)
                else:
                    await _terminalize_stale_checkout(db, checkout, payment)
                if _is_durable_payment_history(payment):
                    return _read(payment, include_client_secret=False)
            else:
                await db.commit()
            raise PaymentNotFoundError()
        await db.commit()
    if (
        not get_settings().tournament_payment_collection_enabled
        and payment.provider_payment_id is None
    ):
        try:
            intent = await provider.retrieve_payment_intent(payment.durable_identity)
        except (TimeoutError, PaymentProviderUncertainError):
            # A transport failure still cannot distinguish no provider object
            # from an accepted create. Preserve the obligation for recovery.
            return _read(payment)
        except PaymentProviderNotFoundError:
            payment = await reload_payment_after_provider_io_locked(
                db,
                tournament_id=tournament_id,
                checkout_id=checkout_id,
                payer_account_id=actor.id,
                payment_id=payment.id,
            )
            if _is_durable_payment_history(payment):
                await db.commit()
                return _read(payment, include_client_secret=False)
            # Another request may have bound an intent while metadata lookup
            # was in flight. That remotely mutable obligation must remain
            # sweepable; collection disablement only terminalizes an intent
            # that is still provably absent after the locked reload.
            if payment.provider_payment_id is not None:
                await db.commit()
                raise PaymentNotFoundError() from None
            if payment.provider_mismatch_at is not None:
                # Signed or lookup evidence was seen but failed immutable
                # association checks. A later metadata miss does not prove the
                # payment never existed, so collection disablement must not
                # erase the quarantined recovery obligation.
                await db.commit()
                return _read(payment)
            now = await _database_now(db)
            payment.checkout.status = TournamentCheckoutStatus.cancelled
            payment.checkout.cancelled_at = now
            if payment.provider_status != UNCERTAIN_CREATE_PROVIDER_STATUS:
                payment.state = TournamentPaymentState.canceled
            payment.updated_at = now
            stage_event(
                db,
                payment.checkout.payer_account_id,
                EventKind.dashboard_changed,
            )
            await db.commit()
            raise PaymentCollectionDisabledError() from None
        payment = await _store_provider_result(db, payment_id=payment.id, intent=intent)
        if payment.provider_payment_id is None:
            # The lookup returned an object that failed immutable association
            # validation. Keep the uncertain-create obligation quarantined and
            # retryable without treating the foreign object as a binding.
            return _read(payment)
        payment = await _revalidate_bound_payment_authority(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            payer_account_id=checkout.payer_account_id,
            payment_id=payment.id,
        )
        return _read(payment)

    if receipt_email_supplied:
        # Receipt destinations are account PII. Reacquire the lifecycle lock
        # before persisting an edit: the authorization check above deliberately
        # released its locks before provider I/O, so an erase/merge/deactivate
        # may have won in the meantime.
        payment = await reload_payment_after_provider_io_locked(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            payer_account_id=actor.id,
            payment_id=payment.id,
        )
        if _is_durable_payment_history(payment):
            await db.commit()
            return _read(payment, include_client_secret=False)
        if not await _checkout_has_payment_authority(db, payment.checkout):
            await db.commit()
            raise PaymentNotFoundError()
        if (
            payment.receipt_email != receipt_email
            or payment.receipt_sync_failed_at is not None
        ):
            payment.receipt_email = receipt_email
            # A new desired value owns a fresh sync attempt. A manual-review
            # marker for an older value must not remain operator-visible.
            payment.receipt_sync_failed_at = None
            if payment.provider_payment_id is not None or payment.provider_status in {
                IN_FLIGHT_CREATE_PROVIDER_STATUS,
                UNCERTAIN_CREATE_PROVIDER_STATUS,
            }:
                payment.receipt_sync_pending = True
            payment.updated_at = await _database_now(db)
        # Release lifecycle/checkout/payment locks before the provider call.
        await db.commit()
        if payment.provider_payment_id is not None:
            payment = await _sync_provider_receipt(
                db,
                provider=provider,
                payment_id=payment.id,
                provider_payment_id=payment.provider_payment_id,
                attempted_email=receipt_email,
            )
            payment = await _revalidate_bound_payment_authority(
                db,
                tournament_id=tournament_id,
                checkout_id=checkout_id,
                payer_account_id=checkout.payer_account_id,
                payment_id=payment.id,
            )
            return _read(payment)

    if payment.provider_payment_id is not None:
        if not payment.client_secret:
            try:
                intent = await provider.retrieve_payment_intent(
                    payment.durable_identity
                )
            except (TimeoutError, PaymentProviderUncertainError):
                return _read(payment)
            except PaymentProviderNotFoundError:
                payment = await reload_payment_after_provider_io_locked(
                    db,
                    tournament_id=tournament_id,
                    checkout_id=checkout_id,
                    payer_account_id=checkout.payer_account_id,
                    payment_id=payment.id,
                )
                if _is_durable_payment_history(payment):
                    await db.commit()
                    return _read(payment, include_client_secret=False)
                payment.state = TournamentPaymentState.checking
                payment.updated_at = await _database_now(db)
                stage_event(
                    db,
                    payment.checkout.payer_account_id,
                    EventKind.dashboard_changed,
                )
                await db.commit()
                return _read(payment)
            payment = await _store_provider_result(
                db, payment_id=payment.id, intent=intent
            )
            payment = await _revalidate_bound_payment_authority(
                db,
                tournament_id=tournament_id,
                checkout_id=checkout_id,
                payer_account_id=checkout.payer_account_id,
                payment_id=payment.id,
            )
        return _read(payment)

    provider_create_attempted = False
    try:
        if created_obligation:
            create_request = await provider_create_request_if_authorized(
                db,
                tournament_id=tournament_id,
                checkout_id=checkout_id,
                payer_account_id=checkout.payer_account_id,
                payment_id=payment.id,
            )
            if create_request is None:
                checkout = await _load(db, tournament_id, checkout_id)
                if checkout is None or checkout.payment is None:
                    raise PaymentNotFoundError()
                if checkout.payment.state in {
                    TournamentPaymentState.expired,
                    TournamentPaymentState.canceled,
                }:
                    raise PaymentNotFoundError()
                return _read(checkout.payment)
            provider_create_attempted = True
            intent = await provider.create_payment_intent(create_request)
        else:
            try:
                intent = await provider.retrieve_payment_intent(
                    payment.durable_identity
                )
            except PaymentProviderNotFoundError:
                # A process may die after committing the durable obligation but
                # before provider I/O. Retrying create with the same provider
                # idempotency key is the safe recovery for that exact window.
                create_request = await provider_create_request_if_authorized(
                    db,
                    tournament_id=tournament_id,
                    checkout_id=checkout_id,
                    payer_account_id=checkout.payer_account_id,
                    payment_id=payment.id,
                )
                if create_request is None:
                    checkout = await _load(db, tournament_id, checkout_id)
                    if checkout is None or checkout.payment is None:
                        raise PaymentNotFoundError() from None
                    if checkout.payment.state in {
                        TournamentPaymentState.expired,
                        TournamentPaymentState.canceled,
                    }:
                        raise PaymentNotFoundError() from None
                    return _read(checkout.payment)
                provider_create_attempted = True
                intent = await provider.create_payment_intent(create_request)
    except (
        PaymentProviderAmountInvalidError,
        PaymentProviderCreateRejectedError,
    ) as error:
        payment = await _reload_payment_for_create_rejection_locked(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            payer_account_id=actor.id,
            payment_id=payment.id,
        )
        if payment.provider_payment_id is None:
            now = await _database_now(db)
            payment.state = TournamentPaymentState.failed
            payment.provider_status = "create_rejected"
            payment.support_reference = (
                payment.support_reference or payment_support_reference(payment.id)
            )
            payment.checkout.status = TournamentCheckoutStatus.cancelled
            payment.checkout.cancelled_at = now
            payment.updated_at = now
            recipient_id = await terminal_active_account_id(
                db, payment.checkout.payer_account_id
            )
            if recipient_id is not None:
                stage_event(db, recipient_id, EventKind.dashboard_changed)
            if recipient_id is not None and enqueue_notification_job(
                NotificationJob(
                    user_id=recipient_id,
                    category=NotificationCategory.PAYMENTS,
                    title="Payment could not be started",
                    body=(
                        "Your tournament payment needs review. Contact support with "
                        f"reference {payment.support_reference}."
                    ),
                    link=(
                        f"/tournaments/{payment.checkout.tournament_id}/checkouts/"
                        f"{payment.checkout_id}"
                    ),
                )
            ):
                payment.attention_notified_state = "create_rejected"
            await db.commit()
        if isinstance(error, PaymentProviderAmountInvalidError):
            raise PaymentAmountInvalidError() from None
        raise PaymentCreateRejectedError() from None
    except (TimeoutError, PaymentProviderUncertainError):
        if provider_create_attempted:
            payment = await reload_payment_after_provider_io_locked(
                db,
                tournament_id=tournament_id,
                checkout_id=checkout_id,
                payer_account_id=actor.id,
                payment_id=payment.id,
            )
            if payment.provider_payment_id is None:
                # A concurrent request may have materialized checkout expiry
                # while this accepted create was in flight.  The timeout means
                # provider truth is still unknown, so restore the recoverable
                # aggregate instead of leaving terminal unbound history that a
                # later sweep would ignore.
                payment.state = TournamentPaymentState.preparing
                payment.provider_status = UNCERTAIN_CREATE_PROVIDER_STATUS
                payment.updated_at = await _database_now(db)
            await db.commit()
        return _read(payment)

    payment = await _store_provider_result(db, payment_id=payment.id, intent=intent)
    if payment.provider_payment_id is None:
        # An unassociated durable-identity result is neither a successful
        # recovery nor proof that no provider object exists. Preserve the
        # original uncertain-create aggregate without exposing foreign data.
        return _read(payment)
    payment = await _revalidate_bound_payment_authority(
        db,
        tournament_id=tournament_id,
        checkout_id=checkout_id,
        payer_account_id=checkout.payer_account_id,
        payment_id=payment.id,
    )
    if receipt_email_supplied and intent.id:
        # A receipt edit may have been persisted while an uncertain provider
        # create was being recovered. Bring the recovered intent to that value.
        payment = await _sync_provider_receipt(
            db,
            provider=provider,
            payment_id=payment.id,
            provider_payment_id=intent.id,
            attempted_email=payment.receipt_email,
        )
        payment = await _revalidate_bound_payment_authority(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            payer_account_id=checkout.payer_account_id,
            payment_id=payment.id,
        )
    return _read(payment)


async def read_payment_status(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
) -> TournamentPaymentRead:
    """Authorize, retrieve provider truth without locks, and reconcile it."""
    checkout = await _load(db, tournament_id, checkout_id)
    if checkout is None:
        raise PaymentNotFoundError()
    owns_historical_payment = await is_terminal_merge_survivor(
        db,
        historical_account_id=checkout.payer_account_id,
        candidate_account_id=actor.id,
    )
    can_view_payments = await user_has_permission(
        db, actor.id, PAYMENTS_VIEW_PERMISSION
    )
    if not owns_historical_payment and not can_view_payments:
        raise PaymentNotFoundError()
    if checkout.payment is None:
        # The payer's 404 is the preparation handshake used by the browser.
        # A payments.view operator may inspect the quote, but a read must never
        # create the payer's provider obligation or expose payer-only controls.
        if checkout.payer_account_id == actor.id or not can_view_payments:
            raise PaymentNotFoundError()
        return _read_unavailable_checkout(checkout)
    payment = checkout.payment
    if checkout.payer_account_id != actor.id:
        # Merge survivors and payments.view operators inherit recovery
        # visibility, not the payer's provider-mutating capability. Return the
        # durable local projection that the notification/dashboard linked to,
        # always secret-redacted and without contacting the provider.
        return _read(
            payment,
            include_client_secret=False,
            receipt_editable=False,
        )
    if payment.state in {
        TournamentPaymentState.succeeded,
        TournamentPaymentState.failed,
    }:
        from app.tournament_payment_reconciliation import retry_terminal_payment_outputs

        payment = await retry_terminal_payment_outputs(db, payment_id=payment.id)
        await db.commit()
    if not _is_durable_payment_history(payment):
        try:
            intent = await provider.retrieve_payment_intent(payment.durable_identity)
        except (TimeoutError, PaymentProviderUncertainError):
            pass
        except PaymentProviderNotFoundError:
            # Search-by-metadata can lag even though a verified provider id is
            # already bound. Preserve that identity and surface a safe checking
            # state; a later sweep/read retries retrieval and never creates.
            payment = await reload_payment_after_provider_io_locked(
                db,
                tournament_id=tournament_id,
                checkout_id=checkout_id,
                payer_account_id=checkout.payer_account_id,
                payment_id=payment.id,
            )
            if _is_durable_payment_history(payment):
                await db.commit()
                return _read(payment, include_client_secret=False)
            payment.state = TournamentPaymentState.checking
            payment.updated_at = await _database_now(db)
            stage_event(
                db,
                payment.checkout.payer_account_id,
                EventKind.dashboard_changed,
            )
            await db.commit()
        else:
            from app.tournament_payment_reconciliation import reconcile_provider_intent

            payment = await reconcile_provider_intent(
                db, payment_id=payment.id, intent=intent
            )
            await db.commit()
            checkout = await _load(db, tournament_id, checkout_id)
            if checkout is None or checkout.payment is None:
                raise PaymentNotFoundError()
            payment = checkout.payment
    return _read(payment, include_client_secret=False)
