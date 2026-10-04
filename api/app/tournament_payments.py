"""Transport-neutral Stripe card-payment operations for a tournament checkout.

Three entry points — :func:`prepare_or_resume_payment` (create-or-resume,
the ONLY place the Stripe client secret is returned), :func:`read_payment_status`
(a status read) and the webhook route (``app.tournament_payment_routes``) —
ALL funnel through :func:`reconcile_payment`, the one function that validates a
PaymentIntent against the payment row, quarantines on any mismatch, and admits
each still-pending line exactly once (#1816). See ``api/CLAUDE.md``'s
service-layer conventions and the ticket's planning note for the full design.
"""

import logging
import uuid
from typing import assert_never

from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app import queue as queue_module
from app import required_repairs
from app.config import Settings, get_settings
from app.db import database_now
from app.models import (
    Player,
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentPayment,
    TournamentPaymentErrorCode,
    TournamentPaymentLine,
    TournamentPaymentLineOutcome,
    TournamentPaymentProviderEvent,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentPaymentStatus,
    User,
)
from app.payments.provider import (
    STRIPE_MAX_AMOUNT_CENTS,
    PaymentProvider,
    ProviderCreateRefused,
    ProviderCreateUncertain,
    ProviderIntentCreated,
    ProviderIntentStatus,
    ProviderPaymentIntent,
    ProviderRefused,
    ProviderRetrievalFailed,
    ProviderUnavailable,
    ProviderWebhookEvent,
)
from app.player_accounts import PlayerAccessDenied
from app.realtime import EventKind, stage_event
from app.receipt_addresses import erase_receipt_address
from app.schemas.tournament_checkout import TournamentCheckoutState
from app.schemas.tournament_payment import (
    TournamentPaymentLineRead,
    TournamentPaymentPrepared,
    TournamentPaymentRead,
    TournamentPaymentReceiptRead,
    TournamentPaymentSummary,
)
from app.tournament_authority import lock_tournament
from app.tournament_checkouts import checkout_effective_state
from app.tournament_entries import SettledPayment, admit_to_event
from app.tournament_errors import (
    EntryRefusal,
    EntryRefusedError,
    EventNotFoundError,
    NonSinglesEntryError,
    TournamentNotFoundError,
)
from app.tournament_payment_errors import (
    PaymentNotFoundError,
    PaymentNotReadyError,
    PaymentProviderUnavailableError,
)
from app.tournament_payment_state import (
    TERMINAL_PAYMENT_STATUSES,
    payment_display_state,
    payment_line_outcome_state,
)


def _safe_error_code(
    intent: ProviderPaymentIntent,
) -> TournamentPaymentErrorCode | None:
    """Map Stripe's last payment error onto the safe, player-facing set. Never
    pass Stripe's raw ``decline_code`` or message through (#1816).

    Stripe often reports a decline as the generic ``code: card_declined`` and
    puts the actionable reason, such as ``insufficient_funds``, in
    ``decline_code``. So a ``decline_code`` in the safe set wins, then
    ``code``, and any other error maps to ``card_error``."""
    raw_codes = (intent.last_payment_decline_code, intent.last_payment_error_code)
    if all(raw_code is None for raw_code in raw_codes):
        return None
    for raw_code in raw_codes:
        if raw_code is None:
            continue
        try:
            return TournamentPaymentErrorCode(raw_code)
        except ValueError:
            continue
    return TournamentPaymentErrorCode.card_error


async def record_and_reconcile_provider_event(
    db: AsyncSession,
    *,
    event: ProviderWebhookEvent,
    provider: PaymentProvider,
    settings: Settings,
) -> None:
    """Persist a verified webhook event uniquely, then reconcile its payment.

    A replayed event hits the unique key and stores nothing new. If Stripe
    cannot be reached, :class:`PaymentProviderUnavailableError` propagates, so
    the caller does not acknowledge the event and Stripe's retry reconciles
    it again. The stored row stays. Another delivery of the same event can be
    running concurrently and can already have been acknowledged, so removing
    the row could erase the evidence of an acknowledged event.
    """
    payment_id = await find_payment_id_for_provider_event(db, event)
    await db.execute(
        pg_insert(TournamentPaymentProviderEvent)
        .values(
            provider_event_id=event.id,
            event_type=event.type,
            payment_id=payment_id,
            payload=event.evidence(),
        )
        .on_conflict_do_nothing(index_elements=["provider_event_id"])
    )
    await db.commit()
    if payment_id is None or not event.is_handled:
        return
    # A replay reconciles again. If the process died, or reconcile raised,
    # after the event row committed, Stripe's retry is the only thing left to
    # finish the payment. Reconcile is idempotent: a terminal payment returns
    # at once, and each line admits or refunds exactly once.
    try:
        await reconcile_payment(
            db,
            payment_id=payment_id,
            provider=provider,
            settings=settings,
            source_event=event,
        )
    except PaymentProviderUnavailableError:
        await db.rollback()
        raise


async def find_payment_id_for_provider_event(
    db: AsyncSession, event: ProviderWebhookEvent
) -> uuid.UUID | None:
    """Resolve which payment row an incoming event is about, by the
    PaymentIntent id Fortymm itself stored — never by trusting the webhook's
    own metadata for routing (reconcile re-validates metadata separately,
    against the RETRIEVED intent)."""
    payment_intent_id = event.payment_intent_id
    if payment_intent_id is None:
        return None
    payment_id: uuid.UUID | None = await db.scalar(
        select(TournamentPayment.id).where(
            TournamentPayment.provider_payment_intent_id == payment_intent_id
        )
    )
    return payment_id


def _map_provider_status(
    provider_status: ProviderIntentStatus, *, current: TournamentPaymentStatus
) -> TournamentPaymentStatus:
    """Stripe's PaymentIntent status, mapped to Fortymm's own. ``succeeded``
    keeps the current status: only ``_admit`` sets ``succeeded``, after this
    module's own validation, never as a bare copy of Stripe's word."""
    if (
        current is TournamentPaymentStatus.cancel_requested
        and provider_status is not ProviderIntentStatus.CANCELED
    ):
        # The director's cancel is authoritative. A non-terminal Stripe status
        # must not un-flag it. Only an actual ``canceled``, or a ``succeeded``
        # that ``_admit`` handles, moves it on.
        return current
    match provider_status:
        case (
            ProviderIntentStatus.REQUIRES_PAYMENT_METHOD
            | ProviderIntentStatus.REQUIRES_CONFIRMATION
        ):
            return TournamentPaymentStatus.ready
        case ProviderIntentStatus.REQUIRES_ACTION:
            return TournamentPaymentStatus.action_required
        case ProviderIntentStatus.PROCESSING | ProviderIntentStatus.REQUIRES_CAPTURE:
            return TournamentPaymentStatus.checking
        case ProviderIntentStatus.CANCELED:
            return TournamentPaymentStatus.cancelled
        case ProviderIntentStatus.SUCCEEDED:
            return current
        case _:
            assert_never(provider_status)


logger = logging.getLogger(__name__)


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
    """The payer, or the merchant account that held financial authority when
    the payment was created. Bound to the payment's own snapshot, so a later
    change of ``TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID`` neither grants the new
    account old payments nor removes them from the account that owns them."""
    return actor.id in (payment.payer_account_id, payment.payee_fortymm_account_id)


def _to_read_schema(
    payment: TournamentPayment, checkout: TournamentCheckout
) -> TournamentPaymentRead:
    """``checkout`` supplies each line's ``event_name`` — a payment line only
    snapshots ``event_id``/``price_cents`` (#1816), never the name, and a
    payment is always one-to-one with the checkout that created its lines
    with the SAME event ids (#1809). Line order matches the checkout read's
    own order: both relationships are ``order_by`` event id."""
    event_names = {line.event_id: line.event_name for line in checkout.lines}
    return TournamentPaymentRead(
        id=payment.id,
        checkout_id=payment.checkout_id,
        reference=payment.reference,
        payment_state=payment_display_state(payment.status),
        last_error_code=payment.last_error_code,
        amount_cents=payment.amount_cents,
        currency=payment.currency,
        created_at=payment.created_at,
        lines=[
            TournamentPaymentLineRead(
                event_id=line.event_id,
                event_name=event_names[line.event_id],
                price_cents=line.price_cents,
                outcome=payment_line_outcome_state(line.outcome),
            )
            for line in payment.lines
        ],
    )


#: The states in which the payer can still act on the PaymentIntent in the
#: browser. Only these get the client secret on a resume.
_PAYER_ACTIONABLE_STATUSES = frozenset(
    {TournamentPaymentStatus.ready, TournamentPaymentStatus.action_required}
)


async def _lock_players_then_checkout(
    db: AsyncSession, *, payer: User | None, checkout_id: uuid.UUID
) -> None:
    """Take the Player and checkout locks in the global order, before the
    payment row. Admission locks the payer's Player, and a retirement holds
    the Player while it invalidates the checkout and cancels its payment. So
    the Players come first, then the checkout, then the payment."""
    player_ids: set[uuid.UUID] = set()
    entrant_player_id = await db.scalar(
        select(TournamentCheckout.entrant_player_id).where(
            TournamentCheckout.id == checkout_id
        )
    )
    if entrant_player_id is not None:
        player_ids.add(entrant_player_id)
    if payer is not None and payer.primary_player is not None:
        player_ids.add(payer.primary_player.id)
    if player_ids:
        await db.execute(
            select(Player.id)
            .where(Player.id.in_(player_ids))
            .order_by(Player.id)
            .with_for_update(read=True)
        )
    await db.execute(
        select(TournamentCheckout.id)
        .where(TournamentCheckout.id == checkout_id)
        .with_for_update()
    )


async def _lock_payment(
    db: AsyncSession, payment_id: uuid.UUID
) -> TournamentPayment | None:
    payment: TournamentPayment | None = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
        .options(selectinload(TournamentPayment.lines))
    )
    return payment


def _intent_matches_payment(
    intent: ProviderPaymentIntent, payment: TournamentPayment, *, key_is_live: bool
) -> bool:
    """The identity checks every PaymentIntent must pass before Fortymm uses
    it: the id Fortymm stored, the key's mode, the amount and currency on the
    row, and the metadata ``payment_id`` Fortymm set."""
    return (
        intent.id == payment.provider_payment_intent_id
        and intent.livemode == key_is_live
        and intent.amount == payment.amount_cents
        and intent.currency.upper() == payment.currency
        and intent.metadata_payment_id == str(payment.id)
    )


def _credentials_own_payment(payment: TournamentPayment, settings: Settings) -> bool:
    """Whether the configured Stripe credentials belong to the platform
    account and the key mode that created this payment. Under another
    account's key, or the same account's other-mode key, Stripe refuses every
    call about the PaymentIntent. That refusal says nothing about the payment,
    so it must never quarantine it."""
    return (
        payment.platform_stripe_account == settings.stripe_account_id
        and payment.platform_stripe_livemode == settings.stripe_key_is_live
    )


async def _drive_provider_create(
    db: AsyncSession,
    payment_id: uuid.UUID,
    provider: PaymentProvider,
    settings: Settings,
) -> tuple[TournamentPayment, str | None]:
    """Create the PaymentIntent under the payment's durable idempotency key.

    No lock and no transaction is held across the Stripe call (#1816: no
    Stripe call inside a transaction that holds capacity locks). A director
    entry updates this row while it holds the tournament lock, so holding the
    row lock across the call would stall that entry behind Stripe. Two racing
    prepares both call Stripe with the SAME key, so Stripe returns one
    PaymentIntent to both. The row lock is taken only to record the result.
    """
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .execution_options(populate_existing=True)
    )
    if payment is None:
        raise PaymentNotFoundError()
    if (
        payment.provider_payment_intent_id is not None
        or payment.status in TERMINAL_PAYMENT_STATUSES
        or not _credentials_own_payment(payment, settings)
    ):
        # Under another platform account's key the create would open a second
        # PaymentIntent on the wrong account. Keep the current status, as an
        # uncertain create does, until the owning credentials return. A
        # terminal payment, such as one whose create Stripe refused, never
        # creates again.
        await db.commit()
        return payment, None
    payee_account = payment.payee_stripe_account
    payer_account_id = payment.payer_account_id
    tournament_id = payment.tournament_id
    checkout_id = payment.checkout_id
    amount_cents = payment.amount_cents
    currency = payment.currency.lower()
    idempotency_key = payment.idempotency_key
    event_count = await db.scalar(
        select(func.count())
        .select_from(TournamentPaymentLine)
        .where(TournamentPaymentLine.payment_id == payment_id)
    )
    await db.commit()

    outcome = await provider.create_payment_intent(
        payee_account=payee_account,
        amount_cents=amount_cents,
        currency=currency,
        idempotency_key=idempotency_key,
        metadata={"payment_id": str(payment_id)},
        statement_descriptor_suffix=f"FORTYMM{event_count}",
    )

    # The admission lock order: payer Account (shared), Tournament, checkout,
    # then the payment row. Every checkout invalidation takes the same order,
    # so the recheck below sees any change that committed during the call.
    await db.scalar(
        select(User)
        .where(User.id == payer_account_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    tournament = await lock_tournament(db, tournament_id)
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == checkout_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    locked = await _lock_payment(db, payment_id)
    if locked is None:
        raise PaymentNotFoundError()
    previous_status = locked.status
    client_secret: str | None = None
    match outcome:
        case ProviderIntentCreated(intent=intent):
            if locked.provider_payment_intent_id is None:
                locked.provider_payment_intent_id = intent.id
                if not _intent_matches_payment(
                    intent, locked, key_is_live=settings.stripe_key_is_live
                ):
                    # Validate before use, exactly as reconcile does. The
                    # payer never gets the secret of a mismatched intent.
                    _quarantine(db, locked, amount_received=intent.amount_received)
                else:
                    locked.status = _map_provider_status(
                        intent.status, current=locked.status
                    )
                if locked.status is TournamentPaymentStatus.cancel_requested:
                    # A director entry superseded this payment while the create
                    # was in flight. Its cancel job found no PaymentIntent id
                    # to cancel, so stage a fresh one now that the id exists.
                    await required_repairs.request_payment_cancel(db, locked.id)
            if (
                locked.provider_payment_intent_id == intent.id
                and locked.status in _PAYER_ACTIONABLE_STATUSES
            ):
                now = await database_now(db)
                if (
                    checkout is not None
                    and checkout_effective_state(checkout, tournament, now)
                    is TournamentCheckoutState.active
                ):
                    client_secret = intent.client_secret
                else:
                    # The quote stopped being live while the create was in
                    # flight, for example a registration window change. That
                    # change marks no payment, so nobody would cancel this
                    # intent. Withhold its secret and cancel it here.
                    locked.status = TournamentPaymentStatus.cancel_requested
                    locked.cancel_requested_at = now
                    await required_repairs.request_payment_cancel(db, locked.id)
        case ProviderCreateUncertain():
            # Keep the current status. A later status read or resume replays
            # the create under the same key.
            pass
        case ProviderCreateRefused():
            # No PaymentIntent exists, and a replay would be refused again.
            # End the payment so reads and resumes stop repeating the call. A
            # payment a cancellation already superseded ends ``cancelled``.
            if (
                locked.provider_payment_intent_id is None
                and locked.status not in TERMINAL_PAYMENT_STATUSES
            ):
                locked.status = (
                    TournamentPaymentStatus.cancelled
                    if locked.status is TournamentPaymentStatus.cancel_requested
                    else TournamentPaymentStatus.failed
                )
    if locked.status is not previous_status:
        # #1809: the open-checkout bar and the panel both refetch on this hint.
        stage_event(db, locked.payer_account_id, EventKind.checkout_changed)
    await db.commit()
    return locked, client_secret


async def _create_payment_row(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    settings: Settings,
) -> uuid.UUID:
    """Commit the provider-create obligation before any Stripe call (#1816).

    A NEW charge needs a live quote. The checkout is validated and the row is
    inserted under the lock order every checkout invalidation takes (payer
    Account, then Tournament, then the checkout row). So a cancellation, a
    director entry or another invalidation either commits first and this
    refuses, or commits after and sees the payment it must cancel. An expired
    or superseded hold can still finish a payment that already exists (a late
    success), but it never starts one.

    Two concurrent first prepares for one checkout serialize on those locks,
    and the second reuses the first one's row. The unique checkout constraint
    stays as the backstop. The caller has already refused a process without
    working payment configuration.
    """
    await db.scalar(
        select(User)
        .where(User.id == actor.id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    try:
        tournament = await lock_tournament(db, tournament_id)
    except TournamentNotFoundError as error:
        raise PaymentNotReadyError() from error
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
        .options(selectinload(TournamentCheckout.lines))
    )
    if checkout is None or checkout.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    existing_id: uuid.UUID | None = await db.scalar(
        select(TournamentPayment.id).where(TournamentPayment.checkout_id == checkout.id)
    )
    if existing_id is not None:
        await db.commit()
        return existing_id
    if (
        checkout_effective_state(checkout, tournament, await database_now(db))
        is not TournamentCheckoutState.active
        # The quote was authorized by the merchant it names. A later change of
        # ``TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID`` must not re-bind it.
        or checkout.merchant_account_id
        != settings.tournament_payment_merchant_account_id
        # Stripe refuses an amount above its limit. Refuse here, before the
        # create obligation commits, rather than persist an impossible create.
        or checkout.total_cents > STRIPE_MAX_AMOUNT_CENTS
    ):
        raise PaymentNotReadyError()
    payment = TournamentPayment(
        checkout_id=checkout.id,
        payer_account_id=actor.id,
        tournament_id=checkout.tournament_id,
        payee_stripe_account=settings.payee_stripe_account,
        platform_stripe_account=settings.stripe_account_id,
        platform_stripe_livemode=settings.stripe_key_is_live,
        payee_fortymm_account_id=checkout.merchant_account_id,
        idempotency_key=f"tournament-payment:{checkout.id}",
        amount_cents=checkout.total_cents,
        currency=checkout.currency,
        lines=[
            TournamentPaymentLine(event_id=line.event_id, price_cents=line.price_cents)
            for line in checkout.lines
        ],
    )
    db.add(payment)
    # #1809: the payer's checking/preparing a payment is itself a checkout
    # state change the open-checkout bar and the checkout panel refetch on.
    stage_event(db, actor.id, EventKind.checkout_changed)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing: uuid.UUID | None = await db.scalar(
            select(TournamentPayment.id).where(
                TournamentPayment.checkout_id == checkout.id
            )
        )
        if existing is None:
            raise
        return existing
    return payment.id


async def _reconcile_or_keep(
    db: AsyncSession,
    payment: TournamentPayment,
    provider: PaymentProvider,
    settings: Settings,
) -> tuple[TournamentPayment, ProviderPaymentIntent | None]:
    """Reconcile for a read. If Stripe cannot be reached, keep the last known
    state instead of failing the read. Also returns the PaymentIntent that
    reconcile retrieved and validated, or ``None``."""
    try:
        reconciled, intent = await _reconcile(
            db, payment_id=payment.id, provider=provider, settings=settings
        )
    except PaymentProviderUnavailableError:
        return payment, None
    return (reconciled if reconciled is not None else payment), intent


async def prepare_or_resume_payment(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
    settings: Settings,
) -> TournamentPaymentPrepared:
    """Create the checkout's PaymentIntent, or resume it if one already
    exists. The ONLY operation that returns the Stripe client secret, and only
    while the payer can still act on the PaymentIntent.

    Without working payment configuration, a resume fails closed exactly as a
    new payment does. A payer who confirms an existing PaymentIntent while no
    webhook signing secret is configured could be charged and never admitted,
    because every Stripe delivery would be rejected."""
    if not settings.card_payments_configured:
        raise PaymentNotReadyError()
    checkout = await _load_checkout_for_payer(
        db, tournament_id=tournament_id, checkout_id=checkout_id, actor=actor
    )
    if checkout.status is not TournamentCheckoutStatus.active:
        raise PaymentNotReadyError()

    payment_id: uuid.UUID | None = await db.scalar(
        select(TournamentPayment.id).where(TournamentPayment.checkout_id == checkout.id)
    )
    if payment_id is None:
        payment_id = await _create_payment_row(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout.id,
            actor=actor,
            settings=settings,
        )

    payment, client_secret = await _drive_provider_create(
        db, payment_id, provider, settings
    )
    if payment.payer_account_id != actor.id:
        raise PaymentNotFoundError()
    if client_secret is None and payment.provider_payment_intent_id is not None:
        # Resume: bring the state up to date, then hand back the secret only
        # while the payer can still act on the PaymentIntent. An actionable
        # status means reconcile validated this intent against the row.
        payment, intent = await _reconcile_or_keep(db, payment, provider, settings)
        if intent is not None and payment.status in _PAYER_ACTIONABLE_STATUSES:
            client_secret = intent.client_secret

    return TournamentPaymentPrepared(
        **_to_read_schema(payment, checkout).model_dump(),
        client_secret=client_secret,
        publishable_key=settings.stripe_publishable_key,
        receipt_address=checkout.receipt_address,
    )


async def read_payment_status(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
    settings: Settings,
) -> TournamentPaymentRead:
    """Read a payment's status after reconciling it against Stripe.

    A payment still ``preparing`` after an uncertain create replays the create
    under the same idempotency key, so it does not stay stuck while nobody
    runs a background job (#1816). If Stripe cannot be reached, the read
    answers with the last known state and changes nothing.
    """
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

    if payment.status not in TERMINAL_PAYMENT_STATUSES:
        if payment.provider_payment_intent_id is None:
            payment, _ = await _drive_provider_create(
                db, payment.id, provider, settings
            )
        if payment.provider_payment_intent_id is not None:
            payment, _ = await _reconcile_or_keep(db, payment, provider, settings)
    return _to_read_schema(payment, checkout)


async def read_payment_receipt(
    db: AsyncSession, *, payment_id: uuid.UUID, actor: User
) -> TournamentPaymentReceiptRead:
    """The itemized receipt of a ``succeeded`` payment (#1810).

    Visible to the payer and the merchant account only. A payment in any other
    state has no receipt, so the answer is the same 404 a stranger gets. No
    provider call: a receipt describes a settled payment.
    """
    payment = await db.scalar(
        select(TournamentPayment).where(TournamentPayment.id == payment_id)
    )
    if (
        payment is None
        or payment.status is not TournamentPaymentStatus.succeeded
        or not _can_view_payment(payment, actor)
    ):
        raise PaymentNotFoundError()
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == payment.checkout_id)
        .options(selectinload(TournamentCheckout.lines))
    )
    if checkout is None:
        raise PaymentNotFoundError()
    return TournamentPaymentReceiptRead(
        **_to_read_schema(payment, checkout).model_dump(),
        receipt_address=(
            payment.receipt_address if actor.id == payment.payer_account_id else None
        ),
    )


async def list_succeeded_payments(
    db: AsyncSession, *, tournament_id: uuid.UUID, actor: User
) -> list[TournamentPaymentSummary]:
    """The actor's own succeeded payments in one tournament, newest first
    (#1810). It lets a payer who left before success find their receipt. Only
    the payer's own payments ever appear, so an unknown tournament and a payer
    with none both answer an empty list."""
    payments = await db.scalars(
        select(TournamentPayment)
        .where(
            TournamentPayment.tournament_id == tournament_id,
            TournamentPayment.payer_account_id == actor.id,
            TournamentPayment.status == TournamentPaymentStatus.succeeded,
        )
        .order_by(TournamentPayment.created_at.desc(), TournamentPayment.id)
    )
    summaries: list[TournamentPaymentSummary] = []
    for payment in payments.all():
        checkout = await db.scalar(
            select(TournamentCheckout)
            .where(TournamentCheckout.id == payment.checkout_id)
            .options(selectinload(TournamentCheckout.lines))
        )
        if checkout is None:
            continue
        summaries.append(
            TournamentPaymentSummary(
                id=payment.id,
                reference=payment.reference,
                amount_cents=payment.amount_cents,
                created_at=payment.created_at,
                event_names=[line.event_name for line in checkout.lines],
            )
        )
    return summaries


async def erase_payment_receipt_address(
    db: AsyncSession, *, payment_id: uuid.UUID, actor: User
) -> None:
    """Erase the receipt address of a succeeded payment, at the payer's request
    (#1810). Payer only: the merchant account can read the receipt but cannot
    erase for the payer. Anyone else, and any payment that has not succeeded,
    gets the same 404 as a missing payment. The payer clears an address before
    success with the checkout PATCH instead."""
    payment = await db.scalar(
        select(TournamentPayment).where(TournamentPayment.id == payment_id)
    )
    if (
        payment is None
        or payment.status is not TournamentPaymentStatus.succeeded
        or payment.payer_account_id != actor.id
    ):
        raise PaymentNotFoundError()
    if not await erase_receipt_address(
        db, checkout_id=payment.checkout_id, payer_account_id=actor.id
    ):
        # The payment moved to another payer between the read and the lock.
        await db.rollback()
        raise PaymentNotFoundError()
    await db.commit()


#: The refusals that mean "this line cannot admit", so the paid line becomes a
#: refund obligation instead of an error that would leave the payment stuck.
_LINE_REFUSALS = (
    EntryRefusedError,
    EventNotFoundError,
    NonSinglesEntryError,
    PlayerAccessDenied,
    TournamentNotFoundError,
)


def _record_line_refund(
    db: AsyncSession,
    payment: TournamentPayment,
    line: TournamentPaymentLine,
    reason: TournamentPaymentRefundReason,
) -> None:
    line.outcome = TournamentPaymentLineOutcome.refund_due
    db.add(
        TournamentPaymentRefundObligation(
            payment_id=payment.id,
            event_id=line.event_id,
            amount_cents=line.price_cents,
            reason=reason,
        )
    )


async def _admit(db: AsyncSession, payment: TournamentPayment) -> None:
    """Convert each still-pending line into a registration exactly once, or a
    refund obligation when it cannot admit (#1816). The caller holds the
    tournament lock and the payment row lock, and no Stripe call runs here.

    Expiry alone does not forfeit a paid line: ``admit_to_event`` rechecks the
    registration window, eligibility and capacity. A cancelled checkout (the
    player's cancellation, which is also how a selection is replaced) or a
    registration window that changed since the quote stays permanent, so a
    late success refunds every line instead of reversing that decision.

    A success clears any decline an earlier attempt recorded.
    """
    payment.last_error_code = None
    payer = await db.get(User, payment.payer_account_id)
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == payment.checkout_id)
        .with_for_update()
    )
    tournament = await db.get(Tournament, payment.tournament_id)
    superseded = (
        checkout is None
        or tournament is None
        or checkout.status is TournamentCheckoutStatus.cancelled
        or checkout.registration_generation != tournament.registration_generation
    )
    if checkout is not None:
        # #1809: snapshotted exactly once, at verified success. A later
        # account-email edit, or a later checkout PATCH, never changes it.
        payment.receipt_address = checkout.receipt_address
        # An erase that ran while the payment was still open (an account erased
        # mid-payment, or the sweep) must not be lost when a late success lands.
        payment.receipt_address_erased_at = checkout.receipt_address_erased_at
    if checkout is not None and checkout.status in (
        TournamentCheckoutStatus.active,
        TournamentCheckoutStatus.expired,
    ):
        # Consume the hold. A completed checkout no longer counts toward
        # capacity, so the payer's own hold cannot block its own admission.
        # The stored status is one the previous release can read (N/N-1,
        # api/README.md). ``completed_at`` is what marks it completed.
        checkout.status = TournamentCheckoutStatus.invalidated
        checkout.completed_at = await database_now(db)
    pending = [
        line
        for line in payment.lines
        if line.outcome is TournamentPaymentLineOutcome.pending
    ]
    if payer is None or superseded:
        for line in pending:
            _record_line_refund(
                db, payment, line, TournamentPaymentRefundReason.checkout_superseded
            )
        payment.status = TournamentPaymentStatus.succeeded
        return
    for line in pending:
        try:
            entrant = await admit_to_event(
                db,
                tournament_id=payment.tournament_id,
                event_id=line.event_id,
                actor=payer,
                user_id=None,
                client_ip=None,
                settled_payment=SettledPayment(event_id=line.event_id),
            )
        except _LINE_REFUSALS as refusal:
            # Admission checks the window, eligibility and capacity before it
            # detects a duplicate entry. A director entry that took the last
            # place therefore refuses as ``event_full``. Look for the entry
            # itself, so the refund records why the paid line did not admit.
            already_entered = (
                isinstance(refusal, EntryRefusedError)
                and refusal.refusal is EntryRefusal.already_entered
            ) or await _payer_already_entered(db, payer, line.event_id)
            _record_line_refund(
                db,
                payment,
                line,
                TournamentPaymentRefundReason.superseded_by_director_entry
                if already_entered
                else TournamentPaymentRefundReason.line_could_not_admit,
            )
        else:
            line.outcome = TournamentPaymentLineOutcome.admitted
            line.entry_id = entrant.id
    payment.status = TournamentPaymentStatus.succeeded


async def _payer_already_entered(
    db: AsyncSession, payer: User, event_id: uuid.UUID
) -> bool:
    player = payer.primary_player
    if player is None:
        return False
    entry_id = await db.scalar(
        select(TournamentEntry.id)
        .where(
            TournamentEntry.event_id == event_id,
            TournamentEntry.user_id == player.id,
            TournamentEntry.status == TournamentEntryStatus.entered,
        )
        .limit(1)
    )
    return entry_id is not None


def _quarantine(
    db: AsyncSession, payment: TournamentPayment, *, amount_received: int | None
) -> None:
    """Admit nobody. ``amount_received`` comes from Fortymm's own retrieval,
    and ``None`` means no verified amount exists ("amount unverified")."""
    payment.status = TournamentPaymentStatus.quarantined
    payment.amount_unverified = amount_received is None
    if amount_received:
        db.add(
            TournamentPaymentRefundObligation(
                payment_id=payment.id,
                event_id=None,
                amount_cents=amount_received,
                reason=TournamentPaymentRefundReason.quarantine,
            )
        )


async def reconcile_payment(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    provider: PaymentProvider,
    settings: Settings,
    source_event: ProviderWebhookEvent | None = None,
) -> TournamentPayment | None:
    """The one function webhooks, the status read, and prepare/resume ALL
    call. See :func:`_reconcile`, which also returns the validated intent."""
    payment, _ = await _reconcile(
        db,
        payment_id=payment_id,
        provider=provider,
        settings=settings,
        source_event=source_event,
    )
    return payment


async def _reconcile(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    provider: PaymentProvider,
    settings: Settings,
    source_event: ProviderWebhookEvent | None = None,
) -> tuple[TournamentPayment | None, ProviderPaymentIntent | None]:
    """The one function webhooks, the status read, and prepare/resume ALL
    call. Validation, quarantine and admission live here exactly once, which
    is what makes exactly-once provable (#1816).

    1. Read the payment without a lock and retrieve the PaymentIntent with
       Fortymm's own key. No lock and no transaction is held across the call.
    2. Take the one lock order every path that touches a checkout or its
       payment takes: payer Account (shared), Tournament, Player (shared),
       checkout, then the payment row. A director entry takes Tournament
       before it touches the payment. A player retirement or an account
       lifecycle change takes the Player or Account before the checkout and
       the payment. So none of them can deadlock with admission, and a
       webhook racing a status read admits once.
    3. Recheck the terminal state under the lock, then validate, and either
       quarantine or apply the provider state.

    Returns the payment and the retrieved PaymentIntent. The intent is
    ``None`` unless it passed validation against the payment row.

    Raises :class:`PaymentProviderUnavailableError` when Stripe cannot be
    reached and nothing else is wrong, or when the configured credentials
    belong to a different platform account than the payment's. The payment is
    then left unchanged.
    """
    snapshot = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .execution_options(populate_existing=True)
    )
    if snapshot is None:
        return None, None
    if (
        snapshot.status in TERMINAL_PAYMENT_STATUSES
        or snapshot.provider_payment_intent_id is None
    ):
        return snapshot, None
    if not _credentials_own_payment(snapshot, settings):
        await db.commit()
        raise PaymentProviderUnavailableError()
    payee_account = snapshot.payee_stripe_account
    payment_intent_id = snapshot.provider_payment_intent_id
    payer_account_id = snapshot.payer_account_id
    tournament_id = snapshot.tournament_id
    checkout_id = snapshot.checkout_id
    await db.commit()

    key_is_live = settings.stripe_key_is_live
    event_ok = source_event is None or (
        source_event.account == payee_account and source_event.livemode == key_is_live
    )
    intent: ProviderPaymentIntent | None = None
    try:
        intent = await provider.retrieve_payment_intent(
            payee_account=payee_account, payment_intent_id=payment_intent_id
        )
    except ProviderUnavailable as error:
        if event_ok:
            raise PaymentProviderUnavailableError() from error
    except ProviderRefused:
        pass

    # Full rows, so ``_admit``'s lookups are served from the identity map.
    payer = await db.scalar(
        select(User)
        .where(User.id == payer_account_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    await lock_tournament(db, tournament_id)
    await _lock_players_then_checkout(db, payer=payer, checkout_id=checkout_id)
    payment = await _lock_payment(db, payment_id)
    if payment is None:
        await db.commit()
        return None, None
    if payment.status in TERMINAL_PAYMENT_STATUSES:
        await db.commit()
        return payment, None

    if intent is None:
        # The quarantine retrieval failed, or the PaymentIntent is not on the
        # payee account: no verified captured amount, so no obligation.
        _quarantine(db, payment, amount_received=None)
        stage_event(db, payment.payer_account_id, EventKind.checkout_changed)
        await db.commit()
        return payment, None

    if not _intent_matches_payment(intent, payment, key_is_live=key_is_live) or (
        not event_ok
    ):
        _quarantine(db, payment, amount_received=intent.amount_received)
        stage_event(db, payment.payer_account_id, EventKind.checkout_changed)
        await db.commit()
        return payment, None

    if source_event is not None and source_event.type == "charge.refunded":
        # Evidence-only (#1816): adds to the trail, changes no obligation.
        await db.commit()
        return payment, intent

    previous_status = payment.status
    if intent.status is ProviderIntentStatus.SUCCEEDED:
        await _admit(db, payment)
    else:
        payment.status = _map_provider_status(intent.status, current=payment.status)
        # Only ``ready`` carries a decline the payer can act on. Every other
        # state reports no current error, so a stale decline is cleared.
        payment.last_error_code = (
            _safe_error_code(intent)
            if payment.status is TournamentPaymentStatus.ready
            else None
        )
        checkout = await db.get(TournamentCheckout, payment.checkout_id)
        tournament = await db.get(Tournament, payment.tournament_id)
        if (
            checkout is not None
            and tournament is not None
            # Only states waiting on the player expire with the hold. A
            # checking payment is Stripe's to finish, and can still succeed
            # after the deadline (#1809): it stays checking until it resolves.
            and payment.status
            in (
                TournamentPaymentStatus.ready,
                TournamentPaymentStatus.action_required,
            )
            and checkout_effective_state(checkout, tournament, await database_now(db))
            is not TournamentCheckoutState.active
        ):
            payment.status = TournamentPaymentStatus.expired
    if payment.status is not previous_status:
        # #1809: covers reconcile's success/fail/expiry transitions, whether
        # driven by a status read or by the webhook.
        stage_event(db, payment.payer_account_id, EventKind.checkout_changed)
    sends_receipt = (
        payment.status is TournamentPaymentStatus.succeeded
        and previous_status is not TournamentPaymentStatus.succeeded
        and payment.receipt_address is not None
    )
    payment_id = payment.id
    await db.commit()
    if sends_receipt:
        _enqueue_receipt_email(payment_id)
    return payment, intent


_RECEIPT_JOB_FAILURE_TTL_SECONDS = 7 * 24 * 60 * 60


def _enqueue_receipt_email(payment_id: uuid.UUID) -> None:
    """Queue the one receipt email for a payment that just succeeded (#1810).

    The job carries only the payment ID. It reads the address at send time, so
    an erasure before the send suppresses the email and the address never sits
    in Redis. Best-effort and after the commit: a Redis outage or a crash here
    loses this one email, never the payment. The receipt page still exists, and
    #1828 closes the gap."""
    try:
        queue_module.get_email_queue().enqueue(
            "app.tournament_payments.send_payment_receipt_email",
            str(payment_id),
            result_ttl=0,
            # Kept for a week. The payload is only the payment id, and a worker
            # that cannot yet import the handler (a rolling deploy) fails the
            # job: it must stay in the failed registry so it can be requeued.
            failure_ttl=_RECEIPT_JOB_FAILURE_TTL_SECONDS,
        )
    except RedisError:
        logger.warning(
            "payment_receipt_enqueue_failed", extra={"payment_id": str(payment_id)}
        )


def run_cancel_payment_intent(payment_id: str) -> None:
    """RQ entry point (the ``payments`` queue): best-effort cancel of the
    PaymentIntent for a payment a director entry superseded (#1816). Thin
    wrapper over ``app.rq_async.run_async_db_job``, matching
    ``app.schedule_solves.run_schedule_solve``'s shape."""
    from app.rq_async import run_async_db_job

    run_async_db_job(
        f"payment-cancel-{payment_id}",
        lambda sessionmaker: _execute_cancel(sessionmaker, uuid.UUID(payment_id)),
    )


async def _execute_cancel(
    sessionmaker: async_sessionmaker[AsyncSession], payment_id: uuid.UUID
) -> None:
    from app.payments.dependencies import provider_for_settings

    async with sessionmaker() as db:
        payment = await db.scalar(
            select(TournamentPayment).where(TournamentPayment.id == payment_id)
        )
        if payment is None or payment.provider_payment_intent_id is None:
            return
        if payment.status in TERMINAL_PAYMENT_STATUSES:
            return
        settings = get_settings()
        if not _credentials_own_payment(payment, settings):
            # Another platform account's key cannot reach this PaymentIntent.
            # Best-effort, as below: reconcile settles it once the owning
            # credentials return.
            return
        provider = provider_for_settings(settings)
        try:
            await provider.cancel_payment_intent(
                payee_account=payment.payee_stripe_account,
                payment_intent_id=payment.provider_payment_intent_id,
            )
        except ProviderRetrievalFailed:
            # Best-effort (module docstring on ``run_cancel_payment_intent``):
            # if Stripe cannot be reached, or the intent already settled
            # (succeeded/canceled), correctness does not depend on this call
            # succeeding — reconcile's own already-entered path covers it.
            return


def send_payment_receipt_email(payment_id: str) -> None:
    """RQ entry point (the ``email`` queue): send the receipt email for a
    succeeded payment (#1810). Thin wrapper over
    ``app.rq_async.run_async_db_job``, like :func:`run_cancel_payment_intent`.
    One attempt, no retry: #1828 adds delivery robustness."""
    from app.rq_async import run_async_db_job

    run_async_db_job(
        f"payment-receipt-{payment_id}",
        lambda sessionmaker: _execute_receipt_email(
            sessionmaker, uuid.UUID(payment_id)
        ),
    )


def _line_outcome_text(outcome: TournamentPaymentLineOutcome) -> str:
    match outcome:
        case TournamentPaymentLineOutcome.admitted:
            return "Entry confirmed"
        case TournamentPaymentLineOutcome.refund_due:
            return "Not admitted — refund pending"
        case TournamentPaymentLineOutcome.pending:
            return "Under review"
        case _:
            assert_never(outcome)


def _admission_headline(outcomes: list[TournamentPaymentLineOutcome]) -> str:
    """ "You're entered" only when every line admitted. Any other mix says so,
    because a player must never read "entered" for an event that refunds."""
    if all(outcome is TournamentPaymentLineOutcome.admitted for outcome in outcomes):
        return "You're entered"
    return "Some entries weren't admitted"


async def _execute_receipt_email(
    sessionmaker: async_sessionmaker[AsyncSession], payment_id: uuid.UUID
) -> None:
    """Read the payment, and send nothing unless it succeeded and still holds
    a receipt address. The address is read here, at send time, so an erasure
    since the enqueue suppresses the email. The wording is combined when the
    payer's ``tournament`` email cell is on, and receipt-only when it is off.

    The payment row stays share-locked until the send returns. An erasure takes
    the same row's update lock, so it waits for the send, and a completed
    erasure is never followed by an email to the erased address."""
    from app import email
    from app.notifications.service import effective_channels
    from app.notifications.taxonomy import NotificationCategory, NotificationChannel

    async with sessionmaker() as db:
        payment = await db.scalar(
            select(TournamentPayment)
            .where(TournamentPayment.id == payment_id)
            .with_for_update(read=True)
        )
        if (
            payment is None
            or payment.status is not TournamentPaymentStatus.succeeded
            or payment.receipt_address is None
        ):
            return
        checkout = await db.scalar(
            select(TournamentCheckout)
            .where(TournamentCheckout.id == payment.checkout_id)
            .options(selectinload(TournamentCheckout.lines))
        )
        if checkout is None:
            return
        names = {line.event_id: line.event_name for line in checkout.lines}
        channels = await effective_channels(
            db,
            payment.payer_account_id,
            NotificationCategory.TOURNAMENT,
            [NotificationChannel.EMAIL],
        )
        headline = _admission_headline([line.outcome for line in payment.lines])
        email.send_payment_receipt_email(
            payment.receipt_address,
            reference=payment.reference,
            lines=[
                (
                    names[line.event_id],
                    line.price_cents,
                    _line_outcome_text(line.outcome),
                )
                for line in payment.lines
            ],
            total_cents=payment.amount_cents,
            receipt_link=f"/payments/{payment_id}/receipt",
            admission_headline=(
                headline if NotificationChannel.EMAIL in channels else None
            ),
        )
